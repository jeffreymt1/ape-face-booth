// Ape Face Booth: find faces in a photo and cover them with a Bored Ape or Mutant Ape.
// Everything runs in the browser. Photos are never uploaded anywhere.
'use strict';

const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/';
const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
const MUTANT_API = 'https://boredapeyachtclub.com/api/mutants/';
const SAMPLE = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Apollo_11_Crew.jpg/1280px-Apollo_11_Crew.jpg',
  credit: 'Sample photo: the Apollo 11 crew, NASA (public domain), via Wikimedia Commons.',
};
const MAX_PHOTO_SIDE = 2400;   // larger photos are scaled down on load
const DETECT_SIDE = 1024;      // face detection runs on a copy this size
const APE_SIDE = 600;          // ape art is normalized to this square

// Where the head sits inside each collection's artwork, as fractions of the image side.
// anchor = the point placed on the center of a person's head; headH = head height (top of skull to chin);
// fade = where the neck fades out, so only the head covers the face.
// eyes = where laser beams start.
const PROFILES = {
  bayc: { anchorX: 0.535, anchorY: 0.49, headH: 0.46, fadeStart: 0.72, fadeEnd: 0.80, eyes: [[0.43, 0.41], [0.59, 0.41]] },
  mayc: { anchorX: 0.52, anchorY: 0.45, headH: 0.38, fadeStart: 0.63, fadeEnd: 0.72, eyes: [[0.45, 0.40], [0.60, 0.40]] },
  mega: { anchorX: 0.53, anchorY: 0.44, headH: 0.38, fadeStart: 0.70, fadeEnd: 0.84, eyes: [[0.47, 0.40], [0.60, 0.40]] },
};
const BOOTH_URL = 'https://jeffreymt1.github.io/ape-face-booth/';
const GIFENC = 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
const COLLECTIONS = {
  bayc: { name: 'Bored Ape', tag: '#BAYC', max: 9999 },
  mayc: { name: 'Mutant Ape', tag: '#MAYC', max: 30007 },
};

const $ = id => document.getElementById(id);
const els = {
  stage: $('stage'), canvas: $('canvas'), dropzone: $('dropzone'), busy: $('busy'), busyText: $('busy-text'),
  file: $('file'), sample: $('sample'), urlForm: $('url-form'), url: $('url'), photoStatus: $('photo-status'),
  colBayc: $('col-bayc'), colMayc: $('col-mayc'), num: $('ape-num'), random: $('random'), apeStatus: $('ape-status'),
  preview: $('ape-preview'), applyAll: $('apply-all'), addMode: $('add-mode'),
  faceStatus: $('face-status'), faceList: $('face-list'), edit: $('edit'), size: $('size'), tilt: $('tilt'),
  flip: $('flip'), sticker: $('sticker'), remove: $('remove'), redetect: $('redetect'),
  caption: $('caption'), count: $('count'), download: $('download'), copy: $('copy'), post: $('post'), share: $('share'),
  toast: $('toast'), credit: $('credit'),
  laser: $('laser'), randomAll: $('random-all'), filter: $('filter'), memeTop: $('meme-top'), memeBottom: $('meme-bottom'), gif: $('gif'),
};
const ctx = els.canvas.getContext('2d');

const state = {
  photo: null,            // canvas holding the photo at working resolution
  overlays: [],           // { key, cx, cy, size, rot, flip, sticker }
  selected: -1,
  collection: 'bayc',
  number: 2442,
  adding: false,
  captionEdited: false,
  photoToken: 0,
  fx: { laser: false, filter: 'none', top: '', bottom: '' },
};
const apeCache = new Map();  // key -> Promise<ape>
let baycIndex = null;        // array of 10,000 IPFS image CIDs

// ---------- small helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const apeKey = (col, n) => `${col}:${n}`;
const apeLabel = (col, n) => `${COLLECTIONS[col].name} #${n}`;
function profileFor(col, n) { return col === 'mayc' && n >= 30000 ? PROFILES.mega : PROFILES[col]; }

let toastTimer;
function toast(msg, ms = 4200) {
  els.toast.textContent = msg; els.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}
function setBusy(text) { els.busy.hidden = !text; if (text) els.busyText.textContent = text; }
function setStatus(el, text, isError = false) { el.textContent = text; el.classList.toggle('error', isError); }

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal, credentials: 'omit' }); } finally { clearTimeout(t); }
}
async function fetchIpfs(cid) {
  let lastErr;
  for (const gw of GATEWAYS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchWithTimeout(gw + cid, 30000);
        if (r.ok) return await r.blob();
        lastErr = new Error('HTTP ' + r.status);
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('IPFS fetch failed');
}

// ---------- ape art ----------
async function getBaycIndex() {
  if (!baycIndex) baycIndex = fetch('bayc-images.json').then(r => { if (!r.ok) throw new Error('index'); return r.json(); });
  return baycIndex;
}

function loadApe(col, n) {
  const key = apeKey(col, n);
  if (!apeCache.has(key)) {
    const p = (async () => {
      let cid;
      if (col === 'bayc') {
        cid = (await getBaycIndex())[n];
      } else {
        const r = await fetchWithTimeout(MUTANT_API + n, 20000);
        if (r.status === 404) {
          const err = new Error(n >= 10000 && n < 30008 ? `Mutant #${n} doesn't exist: that serum hasn't been used yet.` : `There's no Mutant #${n}.`);
          err.userFacing = true; throw err;
        }
        if (!r.ok) throw new Error('Mutant API HTTP ' + r.status);
        cid = (await r.json()).image.replace('ipfs://', '');
      }
      const bmp = await createImageBitmap(await fetchIpfs(cid));
      const full = document.createElement('canvas'); full.width = full.height = APE_SIDE;
      full.getContext('2d').drawImage(bmp, 0, 0, APE_SIDE, APE_SIDE);
      return { key, col, n, full, cut: cutout(full, profileFor(col, n)) };
    })();
    p.catch(() => apeCache.delete(key)); // let a failed load be retried
    apeCache.set(key, p);
  }
  return apeCache.get(key);
}

// Remove the flat (or gradient) background by flood-filling inward from the image edges,
// then fade out the neck so only the head is left.
function cutout(src, prof) {
  const N = src.width;
  const out = document.createElement('canvas'); out.width = out.height = N;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.drawImage(src, 0, 0);
  const img = octx.getImageData(0, 0, N, N); const d = img.data;

  // The background color is the most common color along the border.
  const buckets = new Map();
  const borderIdx = [];
  for (let i = 0; i < N; i++) borderIdx.push(i, (N - 1) * N + i, i * N, i * N + N - 1);
  for (const p of borderIdx) {
    const o = p * 4, k = (d[o] >> 4) << 8 | (d[o + 1] >> 4) << 4 | (d[o + 2] >> 4);
    const b = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += d[o]; b.g += d[o + 1]; b.b += d[o + 2]; buckets.set(k, b);
  }
  let best = null; for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  const sr = best.r / best.n, sg = best.g / best.n, sb = best.b / best.n;
  const dist2 = (o, r, g, b) => (d[o] - r) ** 2 + (d[o + 1] - g) ** 2 + (d[o + 2] - b) ** 2;
  const LOCAL = 16 ** 2, GLOBAL = 120 ** 2, SEED = 40 ** 2;

  const bg = new Uint8Array(N * N);
  const queue = new Int32Array(N * N); let qh = 0, qt = 0;
  for (const p of borderIdx) if (!bg[p] && dist2(p * 4, sr, sg, sb) < SEED) { bg[p] = 1; queue[qt++] = p; }
  while (qh < qt) {
    const p = queue[qh++], x = p % N, y = (p / N) | 0, o = p * 4;
    const nbrs = [x > 0 ? p - 1 : -1, x < N - 1 ? p + 1 : -1, y > 0 ? p - N : -1, y < N - 1 ? p + N : -1];
    for (const q of nbrs) {
      if (q < 0 || bg[q]) continue;
      const qo = q * 4;
      if (dist2(qo, d[o], d[o + 1], d[o + 2]) < LOCAL && dist2(qo, sr, sg, sb) < GLOBAL) { bg[q] = 1; queue[qt++] = q; }
    }
  }
  // Keep only the ape: drop specks of background noise that the fill couldn't reach.
  const comp = new Int32Array(N * N).fill(-1); const sizes = [];
  for (let s = 0; s < N * N; s++) {
    if (bg[s] || comp[s] >= 0) continue;
    const id = sizes.length; let n = 0; qh = qt = 0; queue[qt++] = s; comp[s] = id;
    while (qh < qt) {
      const p = queue[qh++], x = p % N; n++;
      for (const q of [x > 0 ? p - 1 : -1, x < N - 1 ? p + 1 : -1, p - N, p + N]) {
        if (q < 0 || q >= N * N || bg[q] || comp[q] >= 0) continue;
        comp[q] = id; queue[qt++] = q;
      }
    }
    sizes.push(n);
  }
  const keepMin = Math.max(...sizes, 0) * 0.03;
  for (let p = 0; p < N * N; p++) if (!bg[p] && sizes[comp[p]] < keepMin) bg[p] = 1;

  // Clear the background, soften the edge pixels, and fade the neck.
  const f0 = prof.fadeStart * N, f1 = prof.fadeEnd * N;
  for (let y = 0; y < N; y++) {
    const t = y <= f0 ? 1 : y >= f1 ? 0 : 1 - (y - f0) / (f1 - f0);
    const fade = t * t * (3 - 2 * t);
    for (let x = 0; x < N; x++) {
      const p = y * N + x, o = p * 4;
      if (bg[p]) { d[o + 3] = 0; continue; }
      let a = 255;
      if ((x > 0 && bg[p - 1]) || (x < N - 1 && bg[p + 1]) || (y > 0 && bg[p - N]) || (y < N - 1 && bg[p + N])) a = 150;
      d[o + 3] = Math.round(a * fade);
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// ---------- photo loading ----------
async function loadPhotoFromBlob(blob, credit = '') {
  if (!blob || !blob.type.startsWith('image/')) { setStatus(els.photoStatus, "That file isn't an image. Try a JPG, PNG or WebP.", true); return; }
  const token = ++state.photoToken;
  setBusy('Opening photo…');
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (token !== state.photoToken) return;
    state.photo = c; state.overlays = []; state.selected = -1;
    els.canvas.width = c.width; els.canvas.height = c.height;
    els.dropzone.hidden = true;
    els.credit.textContent = credit;
    setStatus(els.photoStatus, `${c.width} × ${c.height}px`);
    render(); syncUi();
    await detectFaces(token);
  } catch (e) {
    console.error(e);
    setStatus(els.photoStatus, "Couldn't open that image. Try saving it and uploading the file instead.", true);
  } finally { if (token === state.photoToken) setBusy(''); }
}

async function loadPhotoFromUrl(url, credit = '') {
  setStatus(els.photoStatus, 'Loading image…');
  try {
    const r = await fetchWithTimeout(url, 30000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await loadPhotoFromBlob(await r.blob(), credit);
  } catch (e) {
    console.error(e);
    setStatus(els.photoStatus, "That site won't share the image with other pages. Save the image to your computer, then use Upload photo.", true);
  }
}

// ---------- face detection ----------
let modelsReady = null;
function loadModels() {
  if (!modelsReady) {
    modelsReady = (async () => {
      for (let i = 0; i < 100 && !window.faceapi; i++) await sleep(100);
      if (!window.faceapi) throw new Error('face-api did not load');
      await faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS);
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODELS);
    })();
    modelsReady.catch(() => { modelsReady = null; });
  }
  return modelsReady;
}

async function detectFaces(token = state.photoToken) {
  if (!state.photo) return;
  setStatus(els.faceStatus, 'Finding faces…'); setBusy('Finding faces…');
  try {
    await loadModels();
    const faces = await findFacesTiled(state.photo);
    if (token !== state.photoToken) return;
    const prof = profileFor(state.collection, state.number);
    state.overlays = faces.map(f => overlayFromFace(f, prof)).sort((a, b) => a.cx - b.cx);
    state.selected = -1;
    const n = state.overlays.length;
    setStatus(els.faceStatus, n ? `Found ${n} face${n === 1 ? '' : 's'}. Click a face below or on the photo to fine-tune it.` : 'No faces found. Turn on "Add ape" and click the photo to place one by hand.');
    if (n) await ensureApes();
    render(); syncUi();
  } catch (e) {
    console.error(e);
    setStatus(els.faceStatus, "Face finder didn't load. Check your connection, then use Find faces again. You can still place apes by hand.", true);
  } finally { if (token === state.photoToken) setBusy(''); }
}

// The detector shrinks its input to 512px, so small faces in group shots vanish. Run it on the
// whole photo and on overlapping 2x2 and 3x3 tiles, then merge duplicates, keeping the most confident.
async function findFacesTiled(src) {
  const W = src.width, H = src.height, found = [];
  const mid = pts => pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
  const grids = Math.max(W, H) > 700 ? [1, 2, 3] : [1, 2];
  for (const n of grids) {
    const tw = Math.min(W, Math.ceil((W / n) * 1.35)), th = Math.min(H, Math.ceil((H / n) * 1.35));
    for (let gy = 0; gy < n; gy++) for (let gx = 0; gx < n; gx++) {
      const x = n === 1 ? 0 : Math.round(((W - tw) * gx) / (n - 1)), y = n === 1 ? 0 : Math.round(((H - th) * gy) / (n - 1));
      const k = Math.min(1, DETECT_SIDE / Math.max(tw, th));
      const c = document.createElement('canvas'); c.width = Math.round(tw * k); c.height = Math.round(th * k);
      c.getContext('2d').drawImage(src, x, y, tw, th, 0, 0, c.width, c.height);
      const rs = await faceapi.detectAllFaces(c, new faceapi.SsdMobilenetv1Options({ minConfidence: n === 1 ? 0.4 : 0.38, maxResults: 60 })).withFaceLandmarks();
      for (const r of rs) {
        const map = p => ({ x: x + p.x / k, y: y + p.y / k }), b = r.detection.box;
        found.push({
          score: r.detection.score, box: { x: x + b.x / k, y: y + b.y / k, w: b.width / k, h: b.height / k },
          leftEye: map(mid(r.landmarks.getLeftEye())), rightEye: map(mid(r.landmarks.getRightEye())), mouth: map(mid(r.landmarks.getMouth())),
        });
      }
      await sleep(0);
    }
  }
  found.sort((a, b) => b.score - a.score);
  const keep = [];
  const overlaps = (a, b) => {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0), iou = inter / (a.w * a.h + b.w * b.h - inter);
    const close = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < a.w * 0.5 && Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < a.h * 0.5;
    return iou > 0.3 || close;
  };
  for (const f of found) if (!keep.some(k => overlaps(k.box, f.box))) keep.push(f);
  return keep;
}

// Turn a detection into an overlay: centre on the head, size from the face box, tilt from the eyes.
function overlayFromFace(f, prof) {
  const k = 1, box = { height: f.box.h };
  const le = f.leftEye, re = f.rightEye, mouth = f.mouth;
  const rot = Math.atan2(re.y - le.y, re.x - le.x);
  const eyes = { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 };
  // A human head runs from roughly 1.3 eye-to-mouth distances above the eyes to 0.9 below the mouth.
  const em = Math.hypot(mouth.x - eyes.x, mouth.y - eyes.y);
  const headH = Math.max(em * 3.4, box.height * 1.32);
  const up = { x: Math.sin(rot), y: -Math.cos(rot) };          // "up" for a tilted head
  const centerFromEyes = em * 0.35;                              // head center sits a little above the eyes-mouth midpoint
  const midEM = { x: (eyes.x + mouth.x) / 2, y: (eyes.y + mouth.y) / 2 };
  const cx = midEM.x + up.x * centerFromEyes, cy = midEM.y + up.y * centerFromEyes;
  return { key: apeKey(state.collection, state.number), cx: cx * k, cy: cy * k, size: (headH / prof.headH) * k, rot, flip: false, sticker: false };
}

async function ensureApes() {
  const keys = [...new Set(state.overlays.map(o => o.key))];
  await Promise.all(keys.map(key => { const [c, n] = key.split(':'); return loadApe(c, +n).catch(() => null); }));
}

// ---------- rendering ----------
const loaded = new Map(); // key -> ape (resolved), filled as loads finish
function apeIfReady(key) {
  if (loaded.has(key)) return loaded.get(key);
  const [c, n] = key.split(':');
  loadApe(c, +n).then(a => { loaded.set(key, a); render(); }).catch(() => {});
  return null;
}

function drawOverlay(c, o) {
  const ape = apeIfReady(o.key); if (!ape) return;
  const prof = profileFor(ape.col, ape.n);
  c.save(); c.translate(o.cx, o.cy); c.rotate(o.rot); if (o.flip) c.scale(-1, 1);
  const s = o.size;
  if (o.sticker) {
    const x = -prof.anchorX * s, y = -prof.anchorY * s, r = s * 0.06;
    c.beginPath(); c.roundRect(x, y, s, s, r); c.clip();
    c.drawImage(ape.full, x, y, s, s);
  } else {
    c.drawImage(ape.cut, -prof.anchorX * s, -prof.anchorY * s, s, s);
  }
  c.restore();
}

function overlayBounds(o) {
  const [c, n] = o.key.split(':'); const prof = profileFor(c, +n); const s = o.size;
  if (o.sticker) return { x0: -prof.anchorX * s, x1: (1 - prof.anchorX) * s, y0: -prof.anchorY * s, y1: (1 - prof.anchorY) * s };
  return { x0: -prof.anchorX * s + s * 0.18, x1: (1 - prof.anchorX) * s - s * 0.12, y0: -prof.anchorY * s + s * 0.06, y1: (prof.fadeEnd - prof.anchorY) * s };
}
function toLocal(o, px, py) {
  const dx = px - o.cx, dy = py - o.cy, cs = Math.cos(-o.rot), sn = Math.sin(-o.rot);
  return { x: dx * cs - dy * sn, y: dx * sn + dy * cs };
}
function toWorld(o, lx, ly) {
  const cs = Math.cos(o.rot), sn = Math.sin(o.rot);
  return { x: o.cx + lx * cs - ly * sn, y: o.cy + lx * sn + ly * cs };
}
function handles(o) {
  const b = overlayBounds(o);
  return { scale: toWorld(o, b.x1, b.y1), rotate: toWorld(o, (b.x0 + b.x1) / 2, b.y0 - uiPx(28)) , top: toWorld(o, (b.x0 + b.x1) / 2, b.y0) };
}
function uiPx(n) { const r = els.canvas.getBoundingClientRect(); return n * (els.canvas.width / Math.max(1, r.width)); }

// ---------- effects ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function vignette(c, W, H, color) {
  const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, color); c.fillStyle = g; c.fillRect(0, 0, W, H);
}
function applyFilter(c, W, H) {
  const f = state.fx.filter; if (f === 'none') return;
  c.save();
  if (f === 'sewer') {
    c.globalCompositeOperation = 'multiply'; c.fillStyle = 'rgb(150, 205, 105)'; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over'; vignette(c, W, H, 'rgba(18, 34, 8, 0.8)');
  } else if (f === 'neon') {
    const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, 'rgba(160, 60, 255, 0.6)'); g.addColorStop(1, 'rgba(255, 40, 150, 0.5)');
    c.globalCompositeOperation = 'overlay'; c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over'; vignette(c, W, H, 'rgba(22, 0, 38, 0.75)');
  } else if (f === 'gold') {
    c.globalCompositeOperation = 'saturation'; c.fillStyle = 'hsl(0, 0%, 50%)'; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'color'; c.fillStyle = 'rgba(214, 160, 30, 0.85)'; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'soft-light'; c.fillStyle = 'rgba(255, 228, 140, 0.5)'; c.fillRect(0, 0, W, H);
  } else if (f === 'toad') {
    c.globalCompositeOperation = 'color'; c.fillStyle = 'rgba(80, 170, 55, 0.55)'; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
    const rnd = mulberry32(7), s = Math.max(W, H) * 0.055;
    c.font = `${s}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 16; i++) {
      const x = rnd() * W, y = rnd() * H;
      c.save(); c.translate(x, y); c.rotate((rnd() - 0.5) * 0.9); c.fillText('🐸', 0, 0); c.restore();
    }
  }
  c.restore();
}
function drawLaser(c, o, alpha = 1) {
  const [col, n] = o.key.split(':'); const prof = profileFor(col, +n); const s = o.size;
  c.save(); c.translate(o.cx, o.cy); c.rotate(o.rot); if (o.flip) c.scale(-1, 1);
  c.globalAlpha = alpha; c.lineCap = 'round';
  for (const [ex, ey] of prof.eyes) {
    const x = (ex - prof.anchorX) * s, y = (ey - prof.anchorY) * s, len = s * 5;
    c.shadowColor = 'rgb(255, 0, 0)'; c.shadowBlur = s * 0.07;
    c.strokeStyle = 'rgba(255, 35, 25, 0.9)'; c.lineWidth = s * 0.04;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + len, y + len * 0.03); c.stroke();
    c.shadowBlur = 0; c.strokeStyle = 'rgba(255, 240, 225, 0.95)'; c.lineWidth = s * 0.012;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + len, y + len * 0.03); c.stroke();
    const g = c.createRadialGradient(x, y, 0, x, y, s * 0.08);
    g.addColorStop(0, 'rgba(255, 255, 255, 1)'); g.addColorStop(0.35, 'rgba(255, 70, 40, 0.95)'); g.addColorStop(1, 'rgba(255, 0, 0, 0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, s * 0.08, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}
function drawMeme(c, W, H) {
  const line = (text, top) => {
    text = text.trim().toUpperCase(); if (!text) return;
    let size = Math.round(H * 0.11);
    const font = px => `${px}px Anton, Impact, "Arial Black", sans-serif`;
    c.font = font(size);
    while (c.measureText(text).width > W * 0.92 && size > 12) { size -= 2; c.font = font(size); }
    c.textAlign = 'center'; c.textBaseline = top ? 'top' : 'bottom'; c.lineJoin = 'round';
    c.lineWidth = Math.max(2, size * 0.13); c.strokeStyle = '#000'; c.fillStyle = '#fff';
    const y = top ? H * 0.03 : H * 0.97;
    c.strokeText(text, W / 2, y); c.fillText(text, W / 2, y);
  };
  c.save(); line(state.fx.top, true); line(state.fx.bottom, false); c.restore();
}

// Draws the whole picture (photo, apes, filter, lasers, meme text) at the canvas's size.
function drawScene(c, { overlays = true, bump = 1, laser = state.fx.laser, laserAlpha = 1 } = {}) {
  const W = state.photo.width, H = state.photo.height, k = c.canvas.width / W;
  c.save(); c.scale(k, k);
  c.drawImage(state.photo, 0, 0);
  if (overlays) state.overlays.forEach(o => drawOverlay(c, bump === 1 ? o : { ...o, size: o.size * bump }));
  applyFilter(c, W, H);
  if (overlays && laser) state.overlays.forEach(o => drawLaser(c, bump === 1 ? o : { ...o, size: o.size * bump }, laserAlpha));
  drawMeme(c, W, H);
  c.restore();
}

function render(forExport = false) {
  if (!state.photo) { ctx.clearRect(0, 0, els.canvas.width, els.canvas.height); return; }
  drawScene(ctx);
  if (forExport || state.selected < 0) return;
  const o = state.overlays[state.selected]; if (!o) return;
  const b = overlayBounds(o), h = handles(o), lw = uiPx(2);
  ctx.save(); ctx.translate(o.cx, o.cy); ctx.rotate(o.rot);
  ctx.setLineDash([uiPx(7), uiPx(5)]); ctx.lineWidth = lw; ctx.strokeStyle = '#f4c534';
  ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); ctx.restore();
  ctx.save(); ctx.lineWidth = lw; ctx.strokeStyle = '#f4c534';
  ctx.beginPath(); ctx.moveTo(h.top.x, h.top.y); ctx.lineTo(h.rotate.x, h.rotate.y); ctx.stroke();
  ctx.fillStyle = '#f4c534'; ctx.strokeStyle = '#2a2105';
  const r = uiPx(9);
  ctx.beginPath(); ctx.arc(h.rotate.x, h.rotate.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillRect(h.scale.x - r, h.scale.y - r, r * 2, r * 2); ctx.strokeRect(h.scale.x - r, h.scale.y - r, r * 2, r * 2);
  ctx.restore();
}

function exportCanvas() {
  const c = document.createElement('canvas'); c.width = state.photo.width; c.height = state.photo.height;
  drawScene(c.getContext('2d'));
  return c;
}
const exportBlob = () => new Promise((res, rej) => exportCanvas().toBlob(b => b ? res(b) : rej(new Error('export failed')), 'image/png'));

// An animated "getting aped" GIF: the original photo, a flash, the apes slam in, lasers flicker.
async function exportGif() {
  const { GIFEncoder, quantize, applyPalette } = await import(GIFENC);
  await ensureApes();
  const W = state.photo.width, H = state.photo.height, k = Math.min(1, 640 / Math.max(W, H));
  const cv = document.createElement('canvas'); cv.width = Math.round(W * k); cv.height = Math.round(H * k);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const frames = [];
  for (let i = 0; i < 4; i++) frames.push({ overlays: false, delay: 160 });
  frames.push({ overlays: false, flash: true, delay: 60 });
  [1.35, 1.12, 0.94, 1.04, 0.99, 1].forEach((bump, i) => frames.push({ bump, delay: 70, laser: state.fx.laser && i > 3 }));
  for (let i = 0; i < 6; i++) frames.push({ delay: i === 5 ? 1800 : 110, laser: state.fx.laser, laserAlpha: i % 2 ? 0.55 : 1 });
  const gif = GIFEncoder();
  for (const f of frames) {
    cx.clearRect(0, 0, cv.width, cv.height);
    drawScene(cx, { overlays: f.overlays !== false, bump: f.bump || 1, laser: !!f.laser, laserAlpha: f.laserAlpha || 1 });
    if (f.flash) { cx.fillStyle = 'rgba(255, 255, 255, 0.7)'; cx.fillRect(0, 0, cv.width, cv.height); }
    const { data } = cx.getImageData(0, 0, cv.width, cv.height);
    const palette = quantize(data, 256); const index = applyPalette(data, palette);
    gif.writeFrame(index, cv.width, cv.height, { palette, delay: f.delay });
    await sleep(0);
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

// ---------- ape picker ----------
let previewToken = 0;
async function pickApe(col, n, { applyToSelected = true } = {}) {
  const max = COLLECTIONS[col].max;
  if (!Number.isInteger(n) || n < 0 || n > max) { setStatus(els.apeStatus, `Pick a number from 0 to ${max}.`, true); return; }
  state.collection = col; state.number = n;
  const token = ++previewToken;
  setStatus(els.apeStatus, 'Fetching from IPFS…');
  const pc = els.preview.getContext('2d'); pc.clearRect(0, 0, els.preview.width, els.preview.height);
  try {
    const ape = await loadApe(col, n);
    loaded.set(ape.key, ape);
    if (token !== previewToken) return;
    pc.drawImage(ape.full, 0, 0, els.preview.width, els.preview.height);
    setStatus(els.apeStatus, apeLabel(col, n));
    if (applyToSelected && state.selected >= 0) retarget(state.overlays[state.selected], ape.key);
    updateCaption(); render(); syncUi();
  } catch (e) {
    if (token !== previewToken) return;
    console.error(e);
    setStatus(els.apeStatus, e.userFacing ? e.message : "Couldn't reach IPFS for that ape. Try again in a moment.", true);
  }
}

// Swap the ape on an overlay, keeping it covering the same head even if the collection changes.
function retarget(o, key) {
  const [c0, n0] = o.key.split(':'), [c1, n1] = key.split(':');
  o.size *= profileFor(c0, +n0).headH / profileFor(c1, +n1).headH;
  o.key = key;
}

function setCollection(col) {
  els.colBayc.setAttribute('aria-checked', String(col === 'bayc'));
  els.colMayc.setAttribute('aria-checked', String(col === 'mayc'));
  els.num.max = COLLECTIONS[col].max;
  const n = clamp(parseInt(els.num.value, 10) || 0, 0, COLLECTIONS[col].max);
  els.num.value = n;
  pickApe(col, n);
}

function updateCaption() {
  if (state.captionEdited) return;
  const keys = [...new Set(state.overlays.map(o => o.key))];
  const names = (keys.length ? keys : [apeKey(state.collection, state.number)]).map(k => { const [c, n] = k.split(':'); return apeLabel(c, n); });
  const tags = [...new Set((keys.length ? keys : [apeKey(state.collection, state.number)]).map(k => COLLECTIONS[k.split(':')[0]].tag))];
  els.caption.value = `Aped in. 🍌 ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' and friends' : ''} ${tags.join(' ')} #ApeFaceBooth ${BOOTH_URL}`;
  els.count.textContent = els.caption.value.length;
}

// ---------- UI state ----------
function syncUi() {
  const has = !!state.photo;
  [els.download, els.copy, els.post, els.share, els.gif].forEach(b => { b.disabled = !has; });
  els.laser.setAttribute('aria-pressed', String(state.fx.laser));
  els.redetect.disabled = !has;
  els.faceList.replaceChildren(...state.overlays.map((o, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    const [c, n] = o.key.split(':');
    b.textContent = `Face ${i + 1} · ${c === 'bayc' ? 'BAYC' : 'MAYC'} #${n}`;
    b.setAttribute('aria-pressed', String(i === state.selected));
    b.addEventListener('click', () => select(i === state.selected ? -1 : i));
    return b;
  }));
  const o = state.overlays[state.selected];
  els.edit.hidden = !o;
  if (o) {
    const base = baseSize();
    els.size.value = Math.round((o.size / base) * 100);
    els.tilt.value = Math.round((o.rot * 180) / Math.PI);
    els.flip.setAttribute('aria-pressed', String(o.flip));
    els.sticker.setAttribute('aria-pressed', String(o.sticker));
  }
  els.addMode.setAttribute('aria-pressed', String(state.adding));
  els.stage.classList.toggle('adding', state.adding);
}
function baseSize() { return state.photo ? Math.max(state.photo.width, state.photo.height) * 0.3 : 300; }

function select(i) {
  state.selected = i;
  const o = state.overlays[i];
  if (o) {
    const [c, n] = o.key.split(':');
    if (c !== state.collection || +n !== state.number) {
      state.collection = c; state.number = +n; els.num.value = n;
      els.colBayc.setAttribute('aria-checked', String(c === 'bayc')); els.colMayc.setAttribute('aria-checked', String(c === 'mayc'));
      els.num.max = COLLECTIONS[c].max;
      pickApe(c, +n, { applyToSelected: false });
    }
  }
  render(); syncUi();
}

// ---------- canvas interaction ----------
let drag = null;
function eventPoint(e) {
  const r = els.canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (els.canvas.width / r.width), y: (e.clientY - r.top) * (els.canvas.height / r.height) };
}
function hitOverlay(p) {
  for (let i = state.overlays.length - 1; i >= 0; i--) {
    const o = state.overlays[i], l = toLocal(o, p.x, p.y), b = overlayBounds(o);
    if (l.x >= b.x0 && l.x <= b.x1 && l.y >= b.y0 && l.y <= b.y1) return i;
  }
  return -1;
}
els.canvas.addEventListener('pointerdown', e => {
  if (!state.photo) return;
  const p = eventPoint(e), o = state.overlays[state.selected];
  const near = (a, r) => Math.hypot(p.x - a.x, p.y - a.y) <= r;
  if (o) {
    const h = handles(o), r = uiPx(16);
    if (near(h.scale, r)) { drag = { mode: 'scale', o, startDist: Math.hypot(p.x - o.cx, p.y - o.cy), startSize: o.size }; }
    else if (near(h.rotate, r)) { drag = { mode: 'rotate', o, startAngle: Math.atan2(p.y - o.cy, p.x - o.cx), startRot: o.rot }; }
  }
  if (!drag) {
    const i = hitOverlay(p);
    if (i >= 0) { select(i); const s = state.overlays[i]; drag = { mode: 'move', o: s, dx: p.x - s.cx, dy: p.y - s.cy }; }
    else if (state.adding) { addOverlayAt(p); return; }
    else { select(-1); return; }
  }
  els.canvas.setPointerCapture(e.pointerId); e.preventDefault();
});
els.canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const p = eventPoint(e), o = drag.o;
  if (drag.mode === 'move') { o.cx = p.x - drag.dx; o.cy = p.y - drag.dy; }
  else if (drag.mode === 'scale') { o.size = Math.max(10, drag.startSize * (Math.hypot(p.x - o.cx, p.y - o.cy) / Math.max(1, drag.startDist))); }
  else if (drag.mode === 'rotate') { o.rot = drag.startRot + (Math.atan2(p.y - o.cy, p.x - o.cx) - drag.startAngle); }
  render();
});
const endDrag = () => { if (drag) { drag = null; syncUi(); } };
els.canvas.addEventListener('pointerup', endDrag);
els.canvas.addEventListener('pointercancel', endDrag);
els.canvas.addEventListener('wheel', e => {
  const o = state.overlays[state.selected]; if (!o) return;
  e.preventDefault(); o.size = Math.max(10, o.size * (e.deltaY < 0 ? 1.06 : 1 / 1.06)); render(); syncUi();
}, { passive: false });

function addOverlayAt(p) {
  const prof = profileFor(state.collection, state.number);
  const sizes = state.overlays.map(o => o.size);
  const size = sizes.length ? sizes.reduce((a, b) => a + b) / sizes.length : Math.max(state.photo.width, state.photo.height) * 0.12 / prof.headH;
  state.overlays.push({ key: apeKey(state.collection, state.number), cx: p.x, cy: p.y, size, rot: 0, flip: false, sticker: false });
  state.adding = false;
  select(state.overlays.length - 1); updateCaption();
  setStatus(els.faceStatus, `${state.overlays.length} ape${state.overlays.length === 1 ? '' : 's'} on the photo.`);
}

els.stage.addEventListener('keydown', e => {
  const o = state.overlays[state.selected]; if (!o) return;
  const step = e.shiftKey ? uiPx(20) : uiPx(4); let handled = true;
  switch (e.key) {
    case 'ArrowLeft': o.cx -= step; break; case 'ArrowRight': o.cx += step; break;
    case 'ArrowUp': o.cy -= step; break; case 'ArrowDown': o.cy += step; break;
    case '+': case '=': o.size *= 1.05; break; case '-': case '_': o.size /= 1.05; break;
    case '[': o.rot -= Math.PI / 90; break; case ']': o.rot += Math.PI / 90; break;
    case 'Delete': case 'Backspace': removeSelected(); break;
    case 'Escape': select(-1); break;
    default: handled = false;
  }
  if (handled) { e.preventDefault(); render(); syncUi(); }
});

function removeSelected() {
  if (state.selected < 0) return;
  state.overlays.splice(state.selected, 1); state.selected = -1;
  updateCaption(); render(); syncUi();
  setStatus(els.faceStatus, `${state.overlays.length} ape${state.overlays.length === 1 ? '' : 's'} on the photo.`);
}

// ---------- controls ----------
els.file.addEventListener('change', () => { const f = els.file.files[0]; if (f) loadPhotoFromBlob(f); els.file.value = ''; });
els.sample.addEventListener('click', () => loadPhotoFromUrl(SAMPLE.url, SAMPLE.credit));
els.urlForm.addEventListener('submit', e => { e.preventDefault(); const u = els.url.value.trim(); if (u) loadPhotoFromUrl(u); });

['dragenter', 'dragover'].forEach(t => els.stage.addEventListener(t, e => { e.preventDefault(); els.stage.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(t => els.stage.addEventListener(t, e => { e.preventDefault(); els.stage.classList.remove('dragover'); }));
els.stage.addEventListener('drop', e => { const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/')); if (f) loadPhotoFromBlob(f); });
document.addEventListener('paste', e => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); loadPhotoFromBlob(item.getAsFile()); }
});

els.colBayc.addEventListener('click', () => setCollection('bayc'));
els.colMayc.addEventListener('click', () => setCollection('mayc'));
let numTimer;
els.num.addEventListener('input', () => { clearTimeout(numTimer); numTimer = setTimeout(() => pickApe(state.collection, parseInt(els.num.value, 10)), 350); });
els.num.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(numTimer); pickApe(state.collection, parseInt(els.num.value, 10)); } });
els.random.addEventListener('click', () => { const n = Math.floor(Math.random() * 10000); els.num.value = n; pickApe(state.collection, n); });
els.applyAll.addEventListener('click', () => {
  if (!state.overlays.length) { toast('No faces yet. Load a photo, or turn on "Add ape" and click the photo.'); return; }
  const key = apeKey(state.collection, state.number);
  state.overlays.forEach(o => retarget(o, key)); updateCaption(); render(); syncUi();
});
els.addMode.addEventListener('click', () => {
  if (!state.photo) { toast('Load a photo first.'); return; }
  state.adding = !state.adding; syncUi();
  if (state.adding) toast('Click the photo where the ape should go.');
});
els.size.addEventListener('input', () => { const o = state.overlays[state.selected]; if (o) { o.size = baseSize() * (+els.size.value / 100); render(); } });
els.tilt.addEventListener('input', () => { const o = state.overlays[state.selected]; if (o) { o.rot = (+els.tilt.value * Math.PI) / 180; render(); } });
els.flip.addEventListener('click', () => { const o = state.overlays[state.selected]; if (o) { o.flip = !o.flip; render(); syncUi(); } });
els.sticker.addEventListener('click', () => { const o = state.overlays[state.selected]; if (o) { o.sticker = !o.sticker; render(); syncUi(); } });
els.remove.addEventListener('click', removeSelected);
els.redetect.addEventListener('click', () => detectFaces());
els.caption.addEventListener('input', () => { state.captionEdited = true; els.count.textContent = els.caption.value.length; });

function fileName() {
  const keys = [...new Set(state.overlays.map(o => o.key))];
  const k = keys[0] || apeKey(state.collection, state.number); const [c, n] = k.split(':');
  return `aped-${c}-${n}.png`;
}
els.download.addEventListener('click', async () => {
  try {
    const url = URL.createObjectURL(await exportBlob());
    const a = document.createElement('a'); a.href = url; a.download = fileName(); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Saved ' + fileName());
  } catch (e) { console.error(e); toast("Couldn't save the image. Try again."); }
});
async function copyImage() {
  if (!navigator.clipboard || !window.ClipboardItem) throw new Error('clipboard unsupported');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
}
els.copy.addEventListener('click', async () => {
  try { await copyImage(); toast('Image copied. Paste it anywhere with ⌘V or Ctrl+V.'); }
  catch (e) { console.error(e); toast("This browser won't copy images. Use Download PNG instead."); }
});
els.post.addEventListener('click', () => {
  const text = els.caption.value.trim();
  const copied = copyImage();                       // starts inside the click, keeps the permission
  window.open('https://x.com/intent/post?text=' + encodeURIComponent(text), '_blank', 'noopener');
  copied.then(() => toast('Image copied. In the X window, paste it into the post with ⌘V or Ctrl+V, then Post.', 7000))
        .catch(() => toast("Couldn't copy the image automatically. Use Download PNG, then attach the file in X.", 7000));
});
els.share.addEventListener('click', async () => {
  try {
    const file = new File([await exportBlob()], fileName(), { type: 'image/png' });
    await navigator.share({ files: [file], text: els.caption.value.trim() });
  } catch (e) { if (e.name !== 'AbortError') { console.error(e); toast("Sharing didn't work here. Use Download PNG instead."); } }
});
// Native share sheet (phones, Safari) can send the image straight to the X app.
try {
  if (navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' })] })) els.share.hidden = false;
} catch (_) {}

els.laser.addEventListener('click', () => { state.fx.laser = !state.fx.laser; render(); syncUi(); });
els.filter.addEventListener('change', () => { state.fx.filter = els.filter.value; render(); });
els.memeTop.addEventListener('input', () => { state.fx.top = els.memeTop.value; render(); });
els.memeBottom.addEventListener('input', () => { state.fx.bottom = els.memeBottom.value; render(); });
els.randomAll.addEventListener('click', async () => {
  if (!state.overlays.length) { toast('No faces yet. Load a photo, or turn on "Add ape" and click the photo.'); return; }
  state.overlays.forEach(o => retarget(o, apeKey(state.collection, Math.floor(Math.random() * 10000))));
  updateCaption(); render(); syncUi();
  setBusy('Fetching apes from IPFS…'); await ensureApes(); setBusy(''); render();
});
els.gif.addEventListener('click', async () => {
  els.gif.disabled = true; setBusy('Making your GIF…');
  try {
    const url = URL.createObjectURL(await exportGif());
    const a = document.createElement('a'); a.href = url; a.download = fileName().replace(/\.png$/, '.gif'); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('GIF saved. Attach it to your post on X.');
  } catch (e) { console.error(e); toast("Couldn't make the GIF. Check your connection and try again."); }
  finally { setBusy(''); els.gif.disabled = !state.photo; }
});
if (document.fonts) document.fonts.load('40px Anton').then(() => render()).catch(() => {});

window.addEventListener('resize', () => render());

// ---------- start ----------
updateCaption();
pickApe('bayc', 2442, { applyToSelected: false });
loadModels().catch(() => {});
loadPhotoFromUrl(SAMPLE.url, SAMPLE.credit);

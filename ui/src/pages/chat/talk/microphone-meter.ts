import { observeDocumentRootAttributes } from "../../../lib/reactive/document-root-attributes.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { observeIntersection, observeResize } from "../../../lib/reactive/observers.ts";
import { subscribeDocumentVisibility } from "../../../lib/reactive/platform.ts";

export type MicrophoneMeterStatus = "listening" | "connecting" | "thinking";
type MotionSource = { read(): boolean; subscribe(notify: (value: boolean) => void): () => void };
const BAR_GAINS = [0.38, 0.62, 0.84, 1, 0.84, 0.62, 0.38];
const BLEED = 8;
const FRAME_INTERVAL = 1_000 / 30;

// Chat boot and listening meters do not need the animation easing samples.
let easeTable: number[] | undefined;
const ease = (value: number) => {
  const table = (easeTable ??= Array.from({ length: 257 }, (_, index) => {
    const x = index / 256;
    let low = 0;
    let high = 1;
    for (let step = 0; step < 18; step += 1) {
      const t = (low + high) / 2;
      const point = 3 * (1 - t) ** 2 * t * 0.42 + 3 * (1 - t) * t ** 2 * 0.58 + t ** 3;
      if (point < x) {
        low = t;
      } else {
        high = t;
      }
    }
    const t = (low + high) / 2;
    return 3 * (1 - t) * t ** 2 + t ** 3;
  }));
  const position = Math.min(256, Math.max(0, value * 256));
  const left = Math.floor(position);
  // Position is clamped to the 257 samples constructed above.
  const start = table[left]!;
  return start + (table[Math.min(256, left + 1)]! - start) * (position - left);
};

/** One status/source lifetime; this owner never touches audio capture or playback. */
export function createMicrophoneMeter(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  bars: readonly HTMLElement[],
  status: MicrophoneMeterStatus,
  reducedMotion: MotionSource,
) {
  const document = host.ownerDocument;
  const window = document.defaultView!;
  const context = canvas.getContext("2d");
  if (!context) {
    return { setLevel: (_level: number) => {}, dispose: () => {} };
  }
  const sprite = document.createElement("canvas");
  const paint = sprite.getContext("2d");
  if (!paint) {
    return { setLevel: (_level: number) => {}, dispose: () => {} };
  }
  const statusAt = performance.now();
  const animated = status !== "listening";
  const thinking = status === "thinking";
  let level: number | undefined;
  let transitionAt = statusAt - 90;
  let fromLevel = 0;
  let ratio = 1;
  let width = 0;
  let height = 0;
  let spriteWidth = 19;
  let spriteHeight = 34;
  let geometry: { x: number; centerY: number; gain: number; index: number }[] = [];
  let frame = 0;
  let lastDrawAt = -Infinity;
  let visible = document.visibilityState !== "hidden";
  let intersects = true;
  let motionReduced = reducedMotion.read();
  let disposed = false;
  let painted = false;
  const presenting = () => !disposed && visible && intersects && !motionReduced && host.isConnected;
  const stop = () => {
    if (frame) {
      window.cancelAnimationFrame(frame);
    }
    frame = 0;
  };
  const schedule = () => {
    if (!frame && geometry.length && presenting()) {
      frame = window.requestAnimationFrame(draw);
    }
  };
  // Each listening scale is affine in level, so one interpolation serves all bars.
  const sampleLevel = (now: number) =>
    fromLevel + ((level ?? 0) - fromLevel) * Math.min(1, (now - transitionAt) / 90);
  function draw(now: number) {
    frame = 0;
    if (!presenting()) {
      return;
    }
    if (now - lastDrawAt < FRAME_INTERVAL - 1) {
      schedule();
      return;
    }
    lastDrawAt = now;
    const currentLevel = animated ? 0 : sampleLevel(now);
    context!.setTransform(ratio, 0, 0, ratio, 0, 0);
    context!.clearRect(0, 0, width, height);
    for (const bar of geometry) {
      let scale = 0.18 + currentLevel * bar.gain * 0.82;
      let opacity = 0.9;
      if (animated) {
        const duration = thinking ? 900 : 1_050;
        const peak = thinking ? 0.45 : 0.5;
        const phase = ((now - statusAt + bar.index * 70) % duration) / duration;
        const amount = phase <= peak ? ease(phase / peak) : 1 - ease((phase - peak) / (1 - peak));
        scale = thinking ? 0.24 + amount * 0.68 : 0.2 + amount * 0.38;
        opacity = thinking ? 0.4 + amount * 0.6 : 0.42 + amount * 0.48;
      }
      const imageHeight = spriteHeight * scale;
      context!.globalAlpha = opacity;
      context!.drawImage(
        sprite,
        0,
        0,
        spriteWidth * ratio,
        spriteHeight * ratio,
        bar.x,
        bar.centerY - imageHeight / 2,
        spriteWidth,
        imageHeight,
      );
    }
    if (!painted) {
      painted = true;
      canvas.dataset.ready = "";
    }
    if (animated || now - transitionAt < 90) {
      schedule();
    }
  }
  const refresh = () => {
    // Resizing clears the bitmap; keep the static bars until its next paint.
    painted = false;
    delete canvas.dataset.ready;
    ratio = Math.max(1, window.devicePixelRatio || 1);
    width = host.offsetWidth + BLEED * 2;
    height = host.offsetHeight + BLEED * 2;
    // MicrophoneActivity supplies its fixed seven layout spans in order.
    const firstBar = bars[0]!;
    const barWidth = firstBar.offsetWidth;
    const barHeight = firstBar.offsetHeight;
    spriteWidth = barWidth + BLEED * 2;
    spriteHeight = barHeight + BLEED * 2;
    geometry = bars.map((bar, index) => ({
      x: bar.offsetLeft,
      centerY: bar.offsetTop + bar.offsetHeight / 2 + BLEED,
      gain: BAR_GAINS[index]!,
      index,
    }));
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    sprite.width = Math.ceil(spriteWidth * ratio);
    sprite.height = Math.ceil(spriteHeight * ratio);
    const style = window.getComputedStyle(firstBar);
    paint!.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint!.fillStyle = style.backgroundColor;
    // Computed box shadows serialize their color before the offsets.
    paint!.shadowColor =
      style.boxShadow.slice(0, style.boxShadow.indexOf(")") + 1) || "transparent";
    paint!.shadowBlur = 5 * ratio;
    paint!.beginPath();
    paint!.roundRect(BLEED, BLEED, barWidth, barHeight, barWidth / 2);
    paint!.fill();
    lastDrawAt = -Infinity;
    schedule();
  };
  let stopResolution: (() => void) | undefined;
  const observeResolution = () => {
    stopResolution?.();
    // Display changes can change DPR without changing the viewport's CSS size.
    const query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    stopResolution =
      query &&
      listen(query, "change", () => {
        refresh();
        observeResolution();
      });
  };
  const syncVisibility = () => {
    if (!presenting()) {
      stop();
    } else {
      lastDrawAt = -Infinity;
      schedule();
    }
  };
  // Readiness belongs to this canvas, so retiring a keyed predecessor cannot
  // hide its successor. The host and seven layout spans stay in place.
  const stops = [
    subscribeDocumentVisibility(document, (next) => {
      visible = next;
      syncVisibility();
    }),
    reducedMotion.subscribe((next) => {
      motionReduced = next;
      refresh();
      syncVisibility();
    }),
    observeResize([host], refresh, { box: "border-box" }),
    observeIntersection([host], (entries) => {
      intersects = entries.some((entry) => entry.isIntersecting);
      syncVisibility();
    }),
    observeDocumentRootAttributes(document, ["data-theme", "data-theme-mode", "style"], refresh),
    () => stopResolution?.(),
  ];
  observeResolution();
  // ResizeObserver supplies initial geometry; eager setup would allocate and
  // paint both bitmaps again when that first observation arrives.
  return {
    setLevel(next: number) {
      if (animated || level === next) {
        return;
      }
      const now = performance.now();
      fromLevel = level === undefined ? next : sampleLevel(now);
      // CSS does not transition solely because an animation was canceled.
      // A new lifetime starts at the current level; only later levels smooth.
      transitionAt = level === undefined ? now - 90 : now;
      level = next;
      schedule();
    },
    dispose() {
      disposed = true;
      stop();
      for (const release of stops) {
        release();
      }
      delete canvas.dataset.ready;
    },
  };
}

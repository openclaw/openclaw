import { observeDocumentRootAttributes } from "../../../lib/reactive/document-root-attributes.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { observeIntersection, observeResize } from "../../../lib/reactive/observers.ts";
import { subscribeDocumentVisibility } from "../../../lib/reactive/platform.ts";

export type MicrophoneMeterStatus = "listening" | "connecting" | "thinking";
type MotionSource = { read(): boolean; subscribe(notify: (value: boolean) => void): () => void };
const FRAME_INTERVAL = 1_000 / 30;
// Listening is a timeline: every step the newest level enters on the right and
// older levels slide left, so the strip shows recent speech across its width.
const STEP_MS = 60;
// Levels arrive about every 100 ms; easing between them keeps neighbors related.
const LEVEL_EASE_MS = 90;
const THINKING_RAMP_MS = 400;
// Bar geometry matches the resting dots drawn by .agent-chat__voice-activity in CSS.
const BAR_WIDTH = 2;
const BAR_PITCH = 4;

/** One status/source lifetime; this owner never touches audio capture or playback. */
export function createMicrophoneMeter(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  status: MicrophoneMeterStatus,
  reducedMotion: MotionSource,
) {
  const document = host.ownerDocument;
  const window = document.defaultView!;
  const context = canvas.getContext("2d");
  if (!context) {
    return { setLevel: (_level: number) => {}, dispose: () => {} };
  }
  const statusAt = performance.now();
  const thinking = status === "thinking";
  // Newest level last; one slot beyond the visible bars slides in from the right edge.
  let history: number[] = [];
  let level: number | undefined;
  let eased = 0;
  let peak = 0;
  let steppedAt = statusAt;
  // The loop stops in silence; the next sound must not count that pause as missed steps.
  let idle = false;
  let ratio = 1;
  let width = 0;
  let height = 0;
  let firstX = 0;
  let color = "";
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
    if (!frame && width && presenting()) {
      frame = window.requestAnimationFrame(draw);
    }
  };
  // Thinking: two slow waves drift across the strip, strongest in the middle.
  const thinkingValue = (now: number, index: number) => {
    const time = (now - statusAt) / 1_000;
    const position = (index / Math.max(1, history.length - 2)) * 2 - 1;
    const wave =
      0.22 * Math.sin(time * 2.4 - position * 3.2) + 0.14 * Math.sin(time * 1.3 + position * 2.1);
    const ramp = Math.min(1, (now - statusAt) / THINKING_RAMP_MS);
    return Math.max(0, (0.3 + wave) * (1 - Math.abs(position) * 0.45) * ramp);
  };
  function advance(now: number, elapsed: number) {
    const target = level ?? 0;
    eased += (target - eased) * Math.min(1, elapsed / LEVEL_EASE_MS);
    if (Math.abs(target - eased) < 0.005) {
      eased = target;
    }
    // Catch up after paused frames without replaying every missed step.
    const steps = Math.min(history.length, Math.floor((now - steppedAt) / STEP_MS));
    if (steps <= 0) {
      return;
    }
    steppedAt = steps === history.length ? now : steppedAt + steps * STEP_MS;
    for (let count = 0; count < steps; count += 1) {
      history.shift();
      // A short syllable between steps still reaches the timeline.
      history.push(count === 0 ? Math.max(eased, peak) : eased);
    }
    peak = 0;
  }
  function draw(now: number) {
    frame = 0;
    if (!presenting()) {
      return;
    }
    if (idle) {
      idle = false;
      steppedAt = now;
      lastDrawAt = now - FRAME_INTERVAL;
    }
    if (now - lastDrawAt < FRAME_INTERVAL - 1) {
      schedule();
      return;
    }
    const elapsed = Number.isFinite(lastDrawAt) ? now - lastDrawAt : STEP_MS;
    lastDrawAt = now;
    if (!thinking) {
      advance(now, elapsed);
    }
    // A silent timeline holds still; the next sound starts a fresh step.
    const quiet = !thinking && eased === 0 && peak === 0 && history.every((value) => value === 0);
    if (quiet) {
      steppedAt = now;
    }
    const minHeight = BAR_WIDTH;
    const maxHeight = Math.max(minHeight, height - 2);
    // Sub-pixel slide between steps; thinking stays in place.
    const offset = thinking ? 0 : Math.min(1, (now - steppedAt) / STEP_MS) * BAR_PITCH;
    context!.setTransform(ratio, 0, 0, ratio, 0, 0);
    context!.clearRect(0, 0, width, height);
    context!.fillStyle = color;
    for (let index = 0; index < history.length; index += 1) {
      const value = thinking ? thinkingValue(now, index) : history[index]!;
      const x = firstX + index * BAR_PITCH - offset;
      if (x + BAR_WIDTH < 0 || x > width) {
        continue;
      }
      // Levels are loudness-compressed; the curve keeps ordinary speech below full height.
      const barHeight = minHeight + (maxHeight - minHeight) * Math.min(1, value) ** 1.8;
      context!.beginPath();
      context!.roundRect(x, (height - barHeight) / 2, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
      context!.fill();
    }
    if (!painted) {
      painted = true;
      canvas.dataset.ready = "";
    }
    // Silence settles into a still row of dots; the host's CSS mask fades both ends.
    if (thinking || !quiet || (level ?? 0) > 0) {
      schedule();
    } else {
      idle = true;
    }
  }
  const refresh = () => {
    // Resizing clears the bitmap; keep the CSS dots until its next paint.
    painted = false;
    delete canvas.dataset.ready;
    ratio = Math.max(1, window.devicePixelRatio || 1);
    width = host.offsetWidth;
    height = host.offsetHeight;
    // The timeline fills whatever width the composer gives it, centered like the CSS dots.
    const count = Math.max(1, Math.floor((width - BAR_WIDTH) / BAR_PITCH) + 1);
    firstX = (width - (count - 1) * BAR_PITCH - BAR_WIDTH) / 2;
    // Keep the newest levels when the width changes; new slots on the left start silent.
    history = [...Array.from({ length: count + 1 }, () => 0), ...history].slice(-(count + 1));
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    color = window.getComputedStyle(host).color;
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
  // hide its successor. The host stays in place.
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
  // paint the bitmap again when that first observation arrives.
  return {
    setLevel(next: number) {
      if (thinking || level === next) {
        return;
      }
      level = next;
      peak = Math.max(peak, next);
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

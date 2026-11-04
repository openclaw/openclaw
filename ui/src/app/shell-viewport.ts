import { listen } from "../lib/reactive/listener.ts";

const KEYBOARD_MIN_SHRINK = 80;
const PRESS_AND_HOLD_MS = 300;

export type ShellViewportSnapshot = Readonly<{
  width: number;
  layoutHeight: number;
  height: number;
  offsetTop: number;
  nativeScale: boolean;
  keyboardVisible: boolean;
  focusHeight: number | null;
}>;

let snapshot: ShellViewportSnapshot | undefined;
const listeners = new Set<() => void>();

/** Read-only facts from the existing observer; subscribing never starts a detector. */
export const shellViewport = {
  get snapshot(): ShellViewportSnapshot | undefined {
    return snapshot;
  },
  subscribe(notify: () => void): () => void {
    listeners.add(notify);
    return () => listeners.delete(notify);
  },
};

function publish(next: ShellViewportSnapshot | undefined): void {
  snapshot = next;
  listeners.forEach((notify) => notify());
}

function hasKeyboardFocus(): boolean {
  let target = document.activeElement;
  while (target?.shadowRoot?.activeElement) {
    target = target.shadowRoot.activeElement;
  }
  if (target instanceof HTMLTextAreaElement) {
    return !target.readOnly && !target.disabled;
  }
  if (target instanceof HTMLInputElement) {
    return (
      !target.readOnly &&
      !target.disabled &&
      ![
        "button",
        "checkbox",
        "color",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ].includes(target.type)
    );
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function consumesVerticalPan(path: readonly EventTarget[], deltaY: number): boolean {
  for (const target of path) {
    if (!(target instanceof Element) || target === document.documentElement) {
      continue;
    }
    if (target.scrollHeight - target.clientHeight < 1) {
      continue;
    }
    const overflow = getComputedStyle(target).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") {
      continue;
    }
    // A finger moving down reveals content above; moving up reveals content below.
    if (
      deltaY > 0
        ? target.scrollTop > 0
        : target.scrollTop + target.clientHeight < target.scrollHeight - 1
    ) {
      return true;
    }
  }
  return false;
}

/**
 * iOS Safari overlays the keyboard without resizing the layout viewport, so a
 * vertical drag that no in-app scroller consumes pans the visual viewport over
 * the uncovered layout area below the shell. Each pan resizes the shell a frame
 * late, which jitters and exposes that blank area. While the keyboard is open,
 * cancel those unclaimed single-finger drags; scrollers and pinch keep working.
 * The decision is made once per gesture because WebKit latches the scroller.
 * A drag that starts after a press-and-hold is text selection or the caret
 * loupe, so it stays native; a held drag over bare chrome may still pan.
 * Safari often pans the header away to reveal the focused editor; a downward
 * drag pans back toward it and only shrinks the shell, so it stays native.
 */
function lockKeyboardPan(viewport: VisualViewport): () => void {
  let start: { x: number; y: number; time: number } | null = null;
  let block: boolean | null = null;
  const stops = [
    listen(
      document,
      "touchstart",
      (event: TouchEvent) => {
        const touch = event.touches.length === 1 ? event.touches[0] : undefined;
        start = touch ? { x: touch.clientX, y: touch.clientY, time: event.timeStamp } : null;
        block = null;
      },
      { passive: true, capture: true },
    ),
    listen(
      document,
      "touchmove",
      (event: TouchEvent) => {
        const touch = event.touches.length === 1 ? event.touches[0] : undefined;
        if (!start || !touch) {
          return;
        }
        if (block === null) {
          const deltaX = touch.clientX - start.x;
          const deltaY = touch.clientY - start.y;
          if (deltaY === 0 || Math.abs(deltaX) > Math.abs(deltaY)) {
            return;
          }
          block =
            event.timeStamp - start.time < PRESS_AND_HOLD_MS &&
            !(deltaY > 0 && viewport.offsetTop > 0) &&
            !consumesVerticalPan(event.composedPath(), deltaY);
        }
        if (block && event.cancelable) {
          event.preventDefault();
        }
      },
      { passive: false, capture: true },
    ),
  ];
  return () => stops.forEach((stop) => stop());
}

/** One viewport owner for the app and fixed/body-portaled shell surfaces. */
export function connectShellViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) {
    return () => {};
  }
  const root = document.documentElement;
  let frame: number | null = null;
  let focusHeight: number | null = null;
  let width = root.clientWidth || window.innerWidth;
  let unlockPan: (() => void) | null = null;
  const update = () => {
    frame = null;
    const layoutHeight = root.clientHeight || window.innerHeight;
    const nextWidth = root.clientWidth || window.innerWidth;
    const focused = hasKeyboardFocus();
    // Rotation changes the unoccluded reference; a portrait height must not
    // classify the following landscape viewport as a still-open keyboard.
    if (width !== nextWidth || !focused) {
      focusHeight = null;
    }
    width = nextWidth;
    if (focused) {
      focusHeight ??= Math.max(layoutHeight, viewport.height);
    }
    const nativeScale = viewport.scale === 1;
    const keyboard =
      nativeScale &&
      focused &&
      Math.max(layoutHeight, focusHeight ?? 0) - viewport.height >= KEYBOARD_MIN_SHRINK;
    // Pages whose resting layout centers content (New Session) dock it on
    // the keyboard instead; CSS cannot observe the visual viewport itself.
    root.toggleAttribute("data-shell-keyboard", keyboard);
    if (keyboard) {
      root.style.setProperty("--shell-safe-area-bottom", "0px");
      unlockPan ??= lockKeyboardPan(viewport);
    } else {
      root.style.removeProperty("--shell-safe-area-bottom");
      unlockPan?.();
      unlockPan = null;
    }

    // Publish a cap independently of keyboard detection: browser chrome and
    // standalone viewport-unit mismatches can hide less than 80px. CSS keeps
    // the smaller dynamic canvas, so this never promotes it to a larger one.
    if (nativeScale) {
      // A panned caret uses layout coordinates: height alone lifts the footer
      // twice. Insets are consumed by the app's CSS, not subtracted here too.
      root.style.setProperty(
        "--shell-viewport-height",
        String(Math.max(0, viewport.height + viewport.offsetTop)) + "px",
      );
    } else {
      root.style.removeProperty("--shell-viewport-height");
    }
    publish({
      width,
      layoutHeight,
      height: viewport.height,
      offsetTop: viewport.offsetTop,
      nativeScale,
      keyboardVisible: keyboard,
      focusHeight,
    });
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(update);
  };
  const stops = [
    listen(viewport, "resize", schedule),
    listen(viewport, "scroll", schedule),
    listen(window, "resize", schedule),
    listen(window, "orientationchange", schedule),
    listen(document, "focusin", () => {
      if (hasKeyboardFocus()) {
        focusHeight ??= viewport.height;
      }
      schedule();
    }),
    listen(document, "focusout", schedule),
  ];
  update();
  return () => {
    stops.forEach((stop) => stop());
    unlockPan?.();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    root.style.removeProperty("--shell-viewport-height");
    root.style.removeProperty("--shell-safe-area-bottom");
    root.removeAttribute("data-shell-keyboard");
    publish(undefined);
  };
}

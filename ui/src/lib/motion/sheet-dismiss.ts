import { listen } from "../reactive/listener.ts";
import { createVelocityTracker, rubberBand } from "./gesture.ts";
import { SHEET_SPRING, springEasing } from "./spring.ts";

/** Downward release speed (px/s) that dismisses regardless of distance. */
const DISMISS_VELOCITY = 400;
/** Pulled fraction of the sheet's height that dismisses a slow release. */
const DISMISS_FRACTION = 0.25;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Slides a bottom sheet off the screen with the sheet spring, fading its backdrop, and
 * resolves when it is gone. `velocity` (px/s, downward) continues a release gesture.
 */
export async function slideSheetOut(
  surface: HTMLElement,
  backdrop: HTMLElement | undefined,
  options: { from?: number; velocity?: number } = {},
): Promise<void> {
  if (reducedMotion()) {
    return;
  }
  const from = options.from ?? 0;
  const distance = surface.getBoundingClientRect().height - from;
  const { easing, durationMs } = springEasing(
    SHEET_SPRING,
    distance > 0 ? (options.velocity ?? 0) / distance : 0,
  );
  surface.style.pointerEvents = "none";
  const timing = { duration: durationMs, easing, fill: "forwards" } as const;
  backdrop?.animate([{ opacity: getComputedStyle(backdrop).opacity }, { opacity: 0 }], timing);
  await surface
    .animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(100%)" }], timing)
    .finished.catch(() => undefined);
}

/**
 * Lets people swipe a bottom sheet down by its grabber, as on iOS: the sheet follows the
 * finger, resists upward pulls, and on release either springs back or slides away at the
 * finger's speed before `dismiss` runs.
 */
export function bindSheetDismissGesture(options: {
  surface: HTMLElement;
  handle: HTMLElement;
  backdrop?: () => HTMLElement | undefined;
  dismiss: () => void;
}): () => void {
  const { surface, handle } = options;
  let drag:
    | {
        pointer: number;
        y: number;
        offset: number;
        height: number;
        velocity: ReturnType<typeof createVelocityTracker>;
      }
    | undefined;
  const paint = (offset: number, height: number) => {
    surface.style.transform = offset ? `translateY(${offset}px)` : "";
    const backdrop = options.backdrop?.();
    if (backdrop) {
      backdrop.style.opacity = String(1 - Math.max(0, Math.min(1, offset / height)));
    }
  };
  const release = (event: PointerEvent) => {
    const completed = drag;
    drag = undefined;
    if (!completed || completed.pointer !== event.pointerId) {
      return;
    }
    const velocity = completed.velocity.velocity(event.timeStamp);
    const { offset, height } = completed;
    if (
      velocity > DISMISS_VELOCITY ||
      (offset > height * DISMISS_FRACTION && velocity > -DISMISS_VELOCITY)
    ) {
      void slideSheetOut(surface, options.backdrop?.(), { from: offset, velocity }).then(
        options.dismiss,
      );
      return;
    }
    paint(0, height);
    if (offset !== 0 && !reducedMotion()) {
      const { easing, durationMs } = springEasing(SHEET_SPRING, -velocity / offset);
      surface.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], {
        duration: durationMs,
        easing,
      });
    }
  };
  const stops = [
    listen(handle, "pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      handle.setPointerCapture(event.pointerId);
      const velocity = createVelocityTracker();
      velocity.add(event.timeStamp, event.clientY);
      drag = {
        pointer: event.pointerId,
        y: event.clientY,
        offset: 0,
        height: surface.getBoundingClientRect().height,
        velocity,
      };
    }),
    listen(handle, "pointermove", (event: PointerEvent) => {
      if (!drag || drag.pointer !== event.pointerId) {
        return;
      }
      drag.velocity.add(event.timeStamp, event.clientY);
      const delta = event.clientY - drag.y;
      drag.offset = delta >= 0 ? delta : -rubberBand(-delta, drag.height);
      paint(drag.offset, drag.height);
    }),
    listen(handle, "pointerup", release),
    listen(handle, "pointercancel", (event: PointerEvent) => {
      if (drag?.pointer === event.pointerId) {
        paint(0, drag.height);
        drag = undefined;
      }
    }),
  ];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}

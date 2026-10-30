import { onCleanup } from "solid-js";
import { listen } from "./listener.ts";

type PointerDragHandlers = {
  move: (event: PointerEvent) => void;
  end: (event: PointerEvent) => void;
  cancel: () => void;
};

type PointerDragSession = {
  pointerId: number;
  target: HTMLElement;
  handlers: PointerDragHandlers;
  stops: Array<() => void>;
};

/** Own one pointer's capture and listeners; callers own admission, geometry, and commit policy. */
export function createPointerDrag() {
  let active: PointerDragSession | undefined;
  let disposed = false;

  const finish = (event?: PointerEvent) => {
    const current = active;
    if (!current) {
      return;
    }
    active = undefined;
    current.stops.forEach((stop) => stop());
    // Releasing capture may synchronously emit lostpointercapture. It must not complete twice.
    if (
      typeof current.target.releasePointerCapture === "function" &&
      (typeof current.target.hasPointerCapture !== "function" ||
        current.target.hasPointerCapture(current.pointerId))
    ) {
      current.target.releasePointerCapture(current.pointerId);
    }
    if (event) {
      current.handlers.end(event);
    } else {
      current.handlers.cancel();
    }
  };
  onCleanup(() => {
    disposed = true;
    finish();
  });

  return {
    cancel: () => finish(),
    start(event: PointerEvent, target: HTMLElement, handlers: PointerDragHandlers): boolean {
      const view = target.ownerDocument.defaultView;
      if (disposed || active || !view) {
        return false;
      }
      try {
        target.setPointerCapture?.(event.pointerId);
      } catch (error) {
        // Synthetic pointer events have no browser-owned pointer to capture; window tracking works.
        if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
          throw error;
        }
      }
      const current: PointerDragSession = {
        pointerId: event.pointerId,
        target,
        handlers,
        stops: [],
      };
      const owns = (next: PointerEvent) =>
        active === current && next.pointerId === current.pointerId;
      active = current;
      current.stops = [
        listen(view, "pointermove", (next) => owns(next) && handlers.move(next)),
        listen(view, "pointerup", (next) => owns(next) && finish(next)),
        listen(view, "pointercancel", (next) => owns(next) && finish()),
        listen(target, "lostpointercapture", (next) => owns(next) && finish()),
        listen(view, "blur", () => finish()),
      ];
      return true;
    },
  };
}

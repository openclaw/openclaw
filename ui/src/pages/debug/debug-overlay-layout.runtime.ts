import { listen } from "../../lib/reactive/listener.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const POSITION_KEY = "openclaw.debug-overlay.position";
type Position = { x: number; y: number };
type Mode = "expanded" | "minimized";

function readPosition(): Position | undefined {
  try {
    const value: unknown = JSON.parse(getSafeLocalStorage()?.getItem(POSITION_KEY) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "x" in value &&
      typeof value.x === "number" &&
      Number.isFinite(value.x) &&
      "y" in value &&
      typeof value.y === "number" &&
      Number.isFinite(value.y)
    ) {
      return { x: value.x, y: value.y };
    }
  } catch {
    // Browser storage may be unavailable; moving the panel still works for this mount.
  }
  return undefined;
}

export function createDebugOverlayLayout(element: HTMLElement) {
  const listeners = new AbortController();
  const eventOptions = { signal: listeners.signal };
  let mode: Mode | undefined;
  let position = readPosition();
  let frame = 0;
  let transitionFrom: DOMRect | undefined;
  let animation: Animation | undefined;
  let drag:
    | {
        id: number;
        start: Position;
        bounds: DOMRect;
        previous?: Position;
        moved: boolean;
      }
    | undefined;

  function update(nextMode: Mode): void {
    if (mode && mode !== nextMode) {
      transitionFrom ??= element.getBoundingClientRect();
      cancelAnimation();
    }
    mode = nextMode;
    if (frame) {
      return;
    }
    // The mode memo precedes the class binding: capture the old box above, then
    // coalesce loading/live updates without losing the pending transition.
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!element.isConnected) {
        return;
      }
      if (animation) {
        // Body-size changes during the 160ms transition settle at its finish.
        return;
      }
      place();
      const before = transitionFrom;
      transitionFrom = undefined;
      if (before) {
        animate(before, element.getBoundingClientRect());
      }
    });
  }

  function animate(before: DOMRect, after: DOMRect): void {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const keyframe = (box: DOMRect) => ({
      left: box.x + "px",
      top: box.y + "px",
      width: box.width + "px",
      height: box.height + "px",
      right: "auto",
      bottom: "auto",
      maxHeight: "none",
    });
    const nextAnimation = element.animate([keyframe(before), keyframe(after)], {
      duration: 160,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
    animation = nextAnimation;
    nextAnimation.onfinish = () => {
      animation = undefined;
      place();
    };
  }

  function clamp(candidate: Position): Position {
    const margin = 8;
    return {
      x: Math.max(margin, Math.min(candidate.x, window.innerWidth - element.offsetWidth - margin)),
      y: Math.max(
        margin,
        Math.min(candidate.y, window.innerHeight - element.offsetHeight - margin),
      ),
    };
  }

  function place(): void {
    if (!position) {
      element.style.removeProperty("left");
      element.style.removeProperty("top");
      element.style.removeProperty("right");
      element.style.removeProperty("bottom");
      return;
    }
    // Clamping is presentation only: expanding or a smaller window must not erase
    // the user's preferred compact position.
    const clamped = clamp(position);
    element.style.left = clamped.x + "px";
    element.style.top = clamped.y + "px";
    element.style.right = "auto";
    element.style.bottom = "auto";
  }

  function save(): void {
    if (!position) {
      return;
    }
    try {
      getSafeLocalStorage()?.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      /* Storage is best-effort, as with other browser presentation preferences. */
    }
  }

  function cancelAnimation(): void {
    animation?.cancel();
    animation = undefined;
  }

  const resize = (): void => {
    transitionFrom = undefined;
    cancelAnimation();
    place();
  };

  const pointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      drag ||
      !(target instanceof Element) ||
      !target.closest(".debug-overlay__header") ||
      target.closest("button")
    ) {
      return;
    }
    cancelAnimation();
    element.setPointerCapture(event.pointerId);
    drag = {
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      bounds: element.getBoundingClientRect(),
      previous: position,
      moved: false,
    };
    element.classList.add("debug-overlay--dragging");
    event.preventDefault();
  };

  const pointerMove = (event: PointerEvent): void => {
    const currentDrag = drag;
    if (!currentDrag || event.pointerId !== currentDrag.id) {
      return;
    }
    const dx = event.clientX - currentDrag.start.x;
    const dy = event.clientY - currentDrag.start.y;
    if (!currentDrag.moved && Math.hypot(dx, dy) < 3) {
      return;
    }
    currentDrag.moved = true;
    position = clamp({ x: currentDrag.bounds.x + dx, y: currentDrag.bounds.y + dy });
    place();
  };

  const pointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== drag?.id) {
      return;
    }
    pointerMove(event);
    if (drag?.moved) {
      save();
    }
    finishDrag();
  };

  const pointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === drag?.id) {
      cancelDrag();
    }
  };

  const cancelDrag = (): void => {
    if (!drag) {
      return;
    }
    position = drag.previous;
    finishDrag();
    place();
  };

  function finishDrag(): void {
    const currentDrag = drag;
    drag = undefined;
    element.classList.remove("debug-overlay--dragging");
    if (currentDrag && element.hasPointerCapture(currentDrag.id)) {
      element.releasePointerCapture(currentDrag.id);
    }
  }

  const keyDown = (event: KeyboardEvent): void => {
    if (
      !(event.target instanceof HTMLElement) ||
      !event.target.matches(".debug-overlay__header") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (dx === 0 && dy === 0) {
      return;
    }
    event.preventDefault();
    cancelAnimation();
    const box = element.getBoundingClientRect();
    position = clamp({ x: box.x + dx, y: box.y + dy });
    place();
    save();
  };

  listen(element, "pointerdown", { handleEvent: pointerDown }, eventOptions);
  listen(element, "pointermove", { handleEvent: pointerMove }, eventOptions);
  listen(element, "pointerup", { handleEvent: pointerUp }, eventOptions);
  listen(element, "pointercancel", { handleEvent: pointerCancel }, eventOptions);
  listen(element, "lostpointercapture", { handleEvent: pointerCancel }, eventOptions);
  listen(element, "keydown", { handleEvent: keyDown }, eventOptions);
  listen(window, "resize", resize, eventOptions);
  listen(window, "blur", cancelDrag, eventOptions);
  const observer = new ResizeObserver(() => {
    if (!animation && !frame) {
      place();
    }
  });
  observer.observe(element);

  function disconnect(): void {
    cancelAnimationFrame(frame);
    frame = 0;
    transitionFrom = undefined;
    cancelAnimation();
    cancelDrag();
    observer.disconnect();
    listeners.abort();
  }
  return { update, disconnect };
}

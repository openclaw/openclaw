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

export class DebugOverlayLayout {
  constructor(private readonly element: HTMLElement) {}
  private mode?: Mode;
  private position = readPosition();
  private frame = 0;
  private transitionFrom?: DOMRect;
  private animation?: Animation;
  private observer?: ResizeObserver;
  private drag?: {
    id: number;
    start: Position;
    bounds: DOMRect;
    previous?: Position;
    moved: boolean;
  };

  update(mode: Mode): void {
    const element = this.element;
    if (this.mode && (this.mode !== mode || this.animation)) {
      this.transitionFrom ??= element.getBoundingClientRect();
      this.cancelAnimation();
    }
    this.mode = mode;
    if (this.frame) {
      return;
    }
    // This directive precedes the class binding: capture the old box above, then
    // coalesce loading/live updates without losing the pending transition.
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!element.isConnected) {
        return;
      }
      this.connect();
      this.place();
      const before = this.transitionFrom;
      this.transitionFrom = undefined;
      if (!before || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return;
      }
      const after = element.getBoundingClientRect();
      const keyframe = (box: DOMRect) => ({
        left: box.x + "px",
        top: box.y + "px",
        width: box.width + "px",
        height: box.height + "px",
        right: "auto",
        bottom: "auto",
        maxHeight: "none",
      });
      this.animation = element.animate([keyframe(before), keyframe(after)], {
        duration: 160,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
      this.animation.onfinish = () => {
        this.animation = undefined;
        this.place();
      };
    });
  }

  private connect(): void {
    const element = this.element;
    element.addEventListener("pointerdown", this.pointerDown);
    element.addEventListener("pointermove", this.pointerMove);
    element.addEventListener("pointerup", this.pointerUp);
    element.addEventListener("pointercancel", this.pointerCancel);
    element.addEventListener("lostpointercapture", this.pointerCancel);
    element.addEventListener("keydown", this.keyDown);
    window.addEventListener("resize", this.resize);
    window.addEventListener("blur", this.cancelDrag);
    this.observer ??= new ResizeObserver(() => {
      if (!this.animation && !this.frame) {
        this.place();
      }
    });
    this.observer.observe(element);
  }

  private clamp(position: Position): Position {
    const element = this.element;
    const margin = 8;
    return {
      x: Math.max(margin, Math.min(position.x, window.innerWidth - element.offsetWidth - margin)),
      y: Math.max(margin, Math.min(position.y, window.innerHeight - element.offsetHeight - margin)),
    };
  }

  private place(): void {
    const element = this.element;
    if (!this.position) {
      element.style.removeProperty("left");
      element.style.removeProperty("top");
      element.style.removeProperty("right");
      element.style.removeProperty("bottom");
      return;
    }
    // Clamping is presentation only: expanding or a smaller window must not erase
    // the user's preferred compact position.
    const position = this.clamp(this.position);
    element.style.left = position.x + "px";
    element.style.top = position.y + "px";
    element.style.right = "auto";
    element.style.bottom = "auto";
  }

  private save(): void {
    if (!this.position) {
      return;
    }
    try {
      getSafeLocalStorage()?.setItem(POSITION_KEY, JSON.stringify(this.position));
    } catch {
      /* Storage is best-effort, as with other browser presentation preferences. */
    }
  }

  private cancelAnimation(): void {
    this.animation?.cancel();
    this.animation = undefined;
  }

  private readonly resize = (): void => {
    this.transitionFrom = undefined;
    this.cancelAnimation();
    this.place();
  };

  private readonly pointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      this.drag ||
      !(target instanceof Element) ||
      !target.closest(".debug-overlay__header") ||
      target.closest("button")
    ) {
      return;
    }
    this.cancelAnimation();
    const element = this.element;
    element.setPointerCapture(event.pointerId);
    this.drag = {
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      bounds: element.getBoundingClientRect(),
      previous: this.position,
      moved: false,
    };
    element.classList.add("debug-overlay--dragging");
    event.preventDefault();
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) {
      return;
    }
    drag.moved = true;
    this.position = this.clamp({ x: drag.bounds.x + dx, y: drag.bounds.y + dy });
    this.place();
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.drag?.id) {
      return;
    }
    this.pointerMove(event);
    if (this.drag?.moved) {
      this.save();
    }
    this.finishDrag();
  };

  private readonly pointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.drag?.id) {
      this.cancelDrag();
    }
  };

  private readonly cancelDrag = (): void => {
    if (!this.drag) {
      return;
    }
    this.position = this.drag.previous;
    this.finishDrag();
    this.place();
  };

  private finishDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    const element = this.element;
    element.classList.remove("debug-overlay--dragging");
    if (drag && element.hasPointerCapture(drag.id)) {
      element.releasePointerCapture(drag.id);
    }
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
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
    let dx = 0;
    let dy = 0;
    switch (event.key) {
      case "ArrowLeft":
        dx = -step;
        break;
      case "ArrowRight":
        dx = step;
        break;
      case "ArrowUp":
        dy = -step;
        break;
      case "ArrowDown":
        dy = step;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.cancelAnimation();
    const box = this.element.getBoundingClientRect();
    this.position = this.clamp({ x: box.x + dx, y: box.y + dy });
    this.place();
    this.save();
  };

  disconnect(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.transitionFrom = undefined;
    this.cancelAnimation();
    this.cancelDrag();
    this.observer?.disconnect();
    const element = this.element;
    element?.removeEventListener("pointerdown", this.pointerDown);
    element?.removeEventListener("pointermove", this.pointerMove);
    element?.removeEventListener("pointerup", this.pointerUp);
    element?.removeEventListener("pointercancel", this.pointerCancel);
    element?.removeEventListener("lostpointercapture", this.pointerCancel);
    element?.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("blur", this.cancelDrag);
  }

  reconnect(): void {
    this.connect();
    this.place();
  }
}

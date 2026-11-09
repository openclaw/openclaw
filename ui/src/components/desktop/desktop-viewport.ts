import { listen } from "../../lib/reactive/listener.ts";
import type { DesktopFocusRegion, DesktopSizingMode } from "./desktop-panel-state.ts";

/** noVNC creates and owns the canvas inside the retained desktop surface. */
export function desktopCanvas(surface: HTMLElement | undefined): HTMLCanvasElement | null {
  return surface?.getElementsByTagName("canvas").item(0) ?? null;
}

/** Connection-local geometry; noVNC still owns canvas scaling and input coordinates. */
export function createDesktopViewport(
  host: HTMLElement,
  options: {
    focusRegion?: DesktopFocusRegion;
    focusHint?: string;
    onFocusRegion?: (region: DesktopFocusRegion) => void;
  },
) {
  const viewport = host.ownerDocument.createElement("div");
  viewport.style.cssText = "width:100%;height:100%;overflow:hidden";
  const target = host.ownerDocument.createElement("div");
  target.style.cssText = "width:100%;height:100%";
  viewport.append(target);
  const overlay = host.ownerDocument.createElement("div");
  overlay.className = "desktop-focus-overlay";
  overlay.hidden = true;
  overlay.tabIndex = 0;
  overlay.setAttribute("role", "button");
  overlay.setAttribute("aria-label", options.focusHint ?? "");
  const hint = host.ownerDocument.createElement("span");
  hint.className = "desktop-focus-hint";
  hint.textContent = options.focusHint ?? "";
  const selection = host.ownerDocument.createElement("div");
  selection.className = "desktop-focus-selection";
  selection.hidden = true;
  overlay.append(hint, selection);
  host.append(viewport, overlay);
  let mode: DesktopSizingMode = "fit";
  let focusRegion = options.focusRegion;
  let resize: ResizeObserver | undefined;
  let framebuffer: MutationObserver | undefined;
  let start: { x: number; y: number; pointerId: number } | undefined;
  let keyboardRegion: DesktopFocusRegion = { x: 0.35, y: 0.2, width: 0.3, height: 0.6 };
  let selectionFrame = 0;
  const showKeyboardRegion = () => {
    const box = desktopCanvas(target)?.getBoundingClientRect();
    if (!box?.width || !box.height) {
      return;
    }
    const parent = overlay.getBoundingClientRect();
    selection.hidden = false;
    selection.style.left = `${box.left - parent.left + keyboardRegion.x * box.width}px`;
    selection.style.top = `${box.top - parent.top + keyboardRegion.y * box.height}px`;
    selection.style.width = `${keyboardRegion.width * box.width}px`;
    selection.style.height = `${keyboardRegion.height * box.height}px`;
  };
  const scheduleKeyboardRegion = () => {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => {
      if (mode === "focus" && !focusRegion) {
        showKeyboardRegion();
      }
    });
  };
  const localPoint = (event: PointerEvent) => {
    const box = overlay.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const stopSelection = () => {
    start = undefined;
    showKeyboardRegion();
  };
  const applyFocus = (region: DesktopFocusRegion) => {
    focusRegion = region;
    overlay.hidden = true;
    options.onFocusRegion?.(region);
    update();
  };
  const stopFocusInput = [
    listen(overlay, "keydown", (event) => {
      if (mode !== "focus" || focusRegion) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applyFocus(keyboardRegion);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const step = 0.05;
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -step : step;
      if (event.shiftKey) {
        const size = horizontal ? "width" : "height";
        const limit = 1 - keyboardRegion[horizontal ? "x" : "y"];
        keyboardRegion = {
          ...keyboardRegion,
          [size]: Math.max(0.05, Math.min(limit, keyboardRegion[size] + delta)),
        };
      } else {
        const axis = horizontal ? "x" : "y";
        keyboardRegion = {
          ...keyboardRegion,
          [axis]: Math.max(
            0,
            Math.min(
              1 - keyboardRegion[horizontal ? "width" : "height"],
              keyboardRegion[axis] + delta,
            ),
          ),
        };
      }
      showKeyboardRegion();
    }),
    listen(overlay, "pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      const point = localPoint(event);
      start = { ...point, pointerId: event.pointerId };
      overlay.setPointerCapture(event.pointerId);
      selection.hidden = false;
      selection.style.left = `${point.x}px`;
      selection.style.top = `${point.y}px`;
      selection.style.width = "0px";
      selection.style.height = "0px";
    }),
    listen(overlay, "pointermove", (event) => {
      if (!start || start.pointerId !== event.pointerId) {
        return;
      }
      const point = localPoint(event);
      selection.style.left = `${Math.min(start.x, point.x)}px`;
      selection.style.top = `${Math.min(start.y, point.y)}px`;
      selection.style.width = `${Math.abs(point.x - start.x)}px`;
      selection.style.height = `${Math.abs(point.y - start.y)}px`;
    }),
    listen(overlay, "pointerup", (event) => {
      if (!start || start.pointerId !== event.pointerId) {
        return;
      }
      const canvas = desktopCanvas(target);
      const box = canvas?.getBoundingClientRect();
      const point = localPoint(event);
      const origin = start;
      stopSelection();
      overlay.releasePointerCapture(event.pointerId);
      if (!box?.width || !box.height) {
        return;
      }
      const overlayBox = overlay.getBoundingClientRect();
      const clamp = (value: number) => Math.max(0, Math.min(1, value));
      const x1 = clamp((Math.min(origin.x, point.x) + overlayBox.left - box.left) / box.width);
      const x2 = clamp((Math.max(origin.x, point.x) + overlayBox.left - box.left) / box.width);
      const y1 = clamp((Math.min(origin.y, point.y) + overlayBox.top - box.top) / box.height);
      const y2 = clamp((Math.max(origin.y, point.y) + overlayBox.top - box.top) / box.height);
      if ((x2 - x1) * box.width < 24 || (y2 - y1) * box.height < 24) {
        return;
      }
      applyFocus({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    }),
    listen(overlay, "pointercancel", stopSelection),
  ];

  const update = () => {
    const canvas = desktopCanvas(target);
    if (!canvas?.width || !canvas.height) {
      return;
    }
    const box = viewport.getBoundingClientRect();
    // Decide gutter reservation from the outer box: a classic scrollbar must not
    // remove its own overflow by shrinking clientWidth/clientHeight on the next frame.
    const overflows =
      mode === "fit-height"
        ? box.height * canvas.width > box.width * canvas.height
        : box.width * canvas.height > box.height * canvas.width;
    viewport.style.overflowX =
      mode === "focus" && focusRegion
        ? "scroll"
        : mode === "fit-height" && overflows
          ? "scroll"
          : "hidden";
    viewport.style.overflowY =
      mode === "focus" && focusRegion
        ? "scroll"
        : mode === "fit-width" && overflows
          ? "scroll"
          : "hidden";
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    // Hidden retained viewers keep their last geometry until presentation resumes.
    if (!width || !height) {
      return;
    }
    // Size noVNC's target rather than its canvas so the input map follows the view.
    const focused = mode === "focus" ? focusRegion : undefined;
    const focusScale = focused
      ? Math.min(width / (focused.width * canvas.width), height / (focused.height * canvas.height))
      : 0;
    const targetWidth = focused
      ? Math.round(canvas.width * focusScale)
      : mode === "fit-height"
        ? Math.max(width, (height * canvas.width) / canvas.height)
        : width;
    const targetHeight = focused
      ? Math.round(canvas.height * focusScale)
      : mode === "fit-width"
        ? Math.max(height, (width * canvas.height) / canvas.width)
        : height;
    target.style.width = `${targetWidth}px`;
    target.style.height = `${targetHeight}px`;
    if (mode === "focus" && !focusRegion) {
      scheduleKeyboardRegion();
    }
    if (focused) {
      viewport.scrollLeft = (focused.x + focused.width / 2) * targetWidth - width / 2;
      viewport.scrollTop = (focused.y + focused.height / 2) * targetHeight - height / 2;
    }
  };
  const stopObserving = () => {
    resize?.disconnect();
    framebuffer?.disconnect();
    resize = undefined;
    framebuffer = undefined;
  };
  return {
    target,
    setMode(next: DesktopSizingMode) {
      if (next === mode) {
        return;
      }
      if (mode === "focus") {
        focusRegion = undefined;
      }
      mode = next;
      overlay.hidden = mode !== "focus" || Boolean(focusRegion);
      if (mode === "focus" && !focusRegion) {
        overlay.focus({ preventScroll: true });
      }
      const axis = mode === "fit-height" || mode === "fit-width" || mode === "focus";
      if (axis) {
        if (!resize) {
          resize = new ResizeObserver(update);
          resize.observe(viewport);
          // Canvas bitmap dimensions are the framebuffer, unlike its scaled CSS size.
          // Child observation also covers noVNC attaching the canvas after connect().
          framebuffer = new MutationObserver(update);
          framebuffer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["width", "height"],
          });
        }
        update();
      } else {
        stopObserving();
        viewport.style.overflow = "hidden";
        target.style.width = "100%";
        target.style.height = "100%";
        viewport.scrollLeft = 0;
        viewport.scrollTop = 0;
      }
    },
    dispose() {
      cancelAnimationFrame(selectionFrame);
      stopFocusInput.forEach((stop) => stop());
      stopObserving();
      viewport.remove();
      overlay.remove();
    },
  };
}

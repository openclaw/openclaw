import type { DesktopSizingMode } from "./desktop-client.ts";

/** Connection-local geometry; noVNC still owns canvas scaling and input coordinates. */
export function createDesktopViewport(host: HTMLElement) {
  const viewport = host.ownerDocument.createElement("div");
  viewport.style.cssText = "width:100%;height:100%;overflow:hidden";
  const target = host.ownerDocument.createElement("div");
  target.style.cssText = "width:100%;height:100%";
  viewport.append(target);
  host.append(viewport);
  let mode: DesktopSizingMode = "fit";
  let resize: ResizeObserver | undefined;
  let framebuffer: MutationObserver | undefined;

  const update = () => {
    const canvas = target.querySelector("canvas");
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
    viewport.style.overflowX = mode === "fit-height" && overflows ? "scroll" : "hidden";
    viewport.style.overflowY = mode === "fit-width" && overflows ? "scroll" : "hidden";
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    // Hidden retained viewers keep their last geometry until presentation resumes.
    if (!width || !height) {
      return;
    }
    // Enlarge only the unconstrained dimension of noVNC's public target. Its
    // normal fit calculation then selects the requested axis, including input scale.
    target.style.width = `${mode === "fit-height" ? Math.max(width, (height * canvas.width) / canvas.height) : width}px`;
    target.style.height = `${mode === "fit-width" ? Math.max(height, (width * canvas.height) / canvas.width) : height}px`;
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
      mode = next;
      const axis = mode === "fit-height" || mode === "fit-width";
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
      stopObserving();
      viewport.remove();
    },
  };
}

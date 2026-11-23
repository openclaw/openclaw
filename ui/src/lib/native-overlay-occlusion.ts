import { hasNativeBrowserBridge } from "../app/native-browser-host.ts";
import { listen } from "./reactive/listener.ts";

type SurfaceElements = () => Iterable<Element>;
export type NativeOverlayOcclusion = "live" | "hidden" | "backdrop" | "hidden-backdrop";
const surfaces = new Set<SurfaceElements>();
const listeners = new Set<() => void>();
let activeOverlays = 0;
let activeBackdrops = 0;
let frame: number | null = null;

function notify() {
  listeners.forEach((listener) => listener());
}

function trackSurfaceLayout() {
  if (surfaces.size === 0 || listeners.size === 0) {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    return;
  }
  if (frame === null) {
    // Menus are positioned after promotion; keep following layout and closing
    // animations only while transient surfaces and native presenters coexist.
    frame = requestAnimationFrame(() => {
      frame = null;
      notify();
      trackSurfaceLayout();
    });
  }
}

function overlapsSurface(bounds: DOMRectReadOnly): boolean {
  for (const elements of surfaces) {
    for (const element of elements()) {
      if (!element.isConnected) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left < bounds.right &&
        rect.right > bounds.left &&
        rect.top < bounds.bottom &&
        rect.bottom > bounds.top
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Native web views sit above the page, including its browser top layer. */
export function acquireNativeOverlayOcclusion(preserveBackdrop = false): () => void {
  if (!hasNativeBrowserBridge()) {
    return () => {};
  }
  activeOverlays += 1;
  activeBackdrops += Number(preserveBackdrop);
  notify();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeOverlays -= 1;
    activeBackdrops -= Number(preserveBackdrop);
    notify();
  };
}

export function subscribeNativeOverlayOcclusion(
  listener: (occlusion: NativeOverlayOcclusion) => void,
  getBounds: () => DOMRectReadOnly | null,
): () => void {
  if (!hasNativeBrowserBridge()) {
    listener("live");
    return () => {};
  }
  let previous: NativeOverlayOcclusion | undefined;
  const update = () => {
    const bounds = activeOverlays === 0 ? getBounds() : null;
    const occlusion =
      activeBackdrops > 0
        ? activeOverlays > activeBackdrops
          ? "hidden-backdrop"
          : "backdrop"
        : activeOverlays > 0 ||
            (bounds && bounds.width > 0 && bounds.height > 0 && overlapsSurface(bounds))
          ? "hidden"
          : "live";
    if (occlusion !== previous) {
      previous = occlusion;
      listener(occlusion);
    }
  };
  listeners.add(update);
  update();
  trackSurfaceLayout();
  return () => {
    listeners.delete(update);
    trackSurfaceLayout();
  };
}

const occludingSurfaces = new WeakSet<HTMLElement>();

/** Lifecycle owners release geometry only after closing has actually finished. */
export function acquireNativeOverlaySurface(element: HTMLElement): () => void {
  if (!hasNativeBrowserBridge()) {
    return () => {};
  }
  const elements = () => [element];
  surfaces.add(elements);
  notify();
  trackSurfaceLayout();
  return () => {
    if (surfaces.delete(elements)) {
      notify();
      trackSurfaceLayout();
    }
  };
}

/** Keep a connected menu above native views through closing and owner removal. */
export function occludeNativeBrowserSurface(element: HTMLElement, elements: SurfaceElements) {
  if (!hasNativeBrowserBridge() || !element.isConnected || occludingSurfaces.has(element)) {
    return;
  }
  surfaces.add(elements);
  trackSurfaceLayout();
  const observer = new MutationObserver(() => {
    if (!element.isConnected) {
      cleanup();
    }
  });
  const onClose = (event: ToggleEvent) => {
    if (event.target === element && event.newState === "closed") {
      cleanup();
    }
  };
  const cleanup = () => {
    observer.disconnect();
    stopClose();
    occludingSurfaces.delete(element);
    surfaces.delete(elements);
    notify();
    trackSurfaceLayout();
  };
  occludingSurfaces.add(element);
  const stopClose = listen(element, "toggle", onClose);
  // Observe every containing root: document observers cannot see shadow-tree
  // removals, and an outer host can itself be removed while its tree stays intact.
  let root = element.getRootNode();
  observer.observe(root, { childList: true, subtree: true });
  while (root instanceof ShadowRoot) {
    root = root.host.getRootNode();
    observer.observe(root, { childList: true, subtree: true });
  }
}

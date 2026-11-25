import type { NativeBrowserCutout } from "../app/native-browser-bridge.ts";
import {
  hasNativeBrowserBridge,
  supportsNativeBrowserCutouts,
} from "../app/native-browser-host.ts";
import { listen } from "./reactive/listener.ts";

type SurfaceElements = () => Iterable<Element>;
export type NativeOverlayOcclusion = "live" | "hidden" | "backdrop" | "hidden-backdrop";
const surfaces = new Set<SurfaceElements>();
const listeners = new Set<() => void>();
const cutoutSurfaces = new Set<SurfaceElements>();
let lastCutouts = "[]";
// Mirror the bound checked by the native bridge.
const CUTOUT_LIMIT = 64;
let activeOverlays = 0;
let activeBackdrops = 0;
let frame: number | null = null;

function notify() {
  listeners.forEach((listener) => listener());
  syncCutouts();
}

function trackSurfaceLayout() {
  if ((surfaces.size === 0 && cutoutSurfaces.size === 0) || listeners.size === 0) {
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

function syncCutouts() {
  const hasSurfaces = listeners.size > 0 && cutoutSurfaces.size > 0;
  if (!hasSurfaces && lastCutouts === "[]") {
    return;
  }
  const cutouts: NativeBrowserCutout[] = [];
  if (hasSurfaces) {
    collect: for (const elements of cutoutSurfaces) {
      for (const element of elements()) {
        if (!(element instanceof HTMLElement) || !element.isConnected) {
          continue;
        }
        const { x, y, width, height } = element.getBoundingClientRect();
        if (width <= 0 || height <= 0) {
          continue;
        }
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.opacity === "0") {
          continue;
        }
        const scale = Math.min(
          width / Math.max(1, element.offsetWidth),
          height / Math.max(1, element.offsetHeight),
        );
        const radius = (Number.parseFloat(style.borderTopLeftRadius) || 0) * scale;
        cutouts.push({ x, y, width, height, radius: Math.min(radius, width / 2, height / 2) });
        if (cutouts.length === CUTOUT_LIMIT) {
          break collect;
        }
      }
    }
  }
  const key = JSON.stringify(cutouts);
  if (key !== lastCutouts) {
    lastCutouts = key;
    // Native presenters already load the bridge; keep it off the web overlay boot path.
    void import("../app/native-browser-bridge.ts").then(({ postNativeBrowserMessage }) => {
      if (lastCutouts === key) {
        void postNativeBrowserMessage({ type: "overlay-cutouts", cutouts });
      }
    });
  }
}

/** Keep passive overlays above the page without suspending the entire native tab. */
export function acquireNativeOverlayCutouts(elements: SurfaceElements): () => void {
  if (!supportsNativeBrowserCutouts()) {
    return () => {};
  }
  cutoutSurfaces.add(elements);
  syncCutouts();
  trackSurfaceLayout();
  return () => {
    if (cutoutSurfaces.delete(elements)) {
      syncCutouts();
      trackSurfaceLayout();
    }
  };
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
  syncCutouts();
  trackSurfaceLayout();
  return () => {
    listeners.delete(update);
    syncCutouts();
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

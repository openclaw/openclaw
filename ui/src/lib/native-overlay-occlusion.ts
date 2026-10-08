import { hasNativeBrowserBridge } from "../app/native-browser-host.ts";

type SurfaceElements = () => Iterable<Element>;
const surfaces = new Set<SurfaceElements>();
const listeners = new Set<() => void>();
let activeOverlays = 0;
let frame: number | null = null;

function notify() {
  for (const listener of listeners) {
    listener();
  }
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
export function acquireNativeOverlayOcclusion(): () => void {
  if (!hasNativeBrowserBridge()) {
    return () => {};
  }
  activeOverlays += 1;
  if (activeOverlays === 1) {
    notify();
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeOverlays -= 1;
    if (activeOverlays === 0) {
      notify();
    }
  };
}

export function subscribeNativeOverlayOcclusion(
  listener: (occluded: boolean) => void,
  getBounds: () => DOMRectReadOnly | null,
): () => void {
  if (!hasNativeBrowserBridge()) {
    listener(false);
    return () => {};
  }
  let previous: boolean | undefined;
  const update = () => {
    const bounds = getBounds();
    const occluded =
      activeOverlays > 0 ||
      Boolean(bounds && bounds.width > 0 && bounds.height > 0 && overlapsSurface(bounds));
    if (occluded !== previous) {
      previous = occluded;
      listener(occluded);
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

/** Keep a connected menu above native views through closing and owner removal. */
export function occludeNativeBrowserSurface(
  element: HTMLElement,
  closeEvent: "toggle" | "wa-after-hide" = "toggle",
  elements: SurfaceElements = () => [element, ...element.querySelectorAll("*")],
) {
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
  const onClose = (event: Event) => {
    if (
      event.target === element &&
      // SAFETY: The toggle branch receives the Popover API event with newState.
      (closeEvent !== "toggle" || (event as ToggleEvent).newState === "closed")
    ) {
      cleanup();
    }
  };
  const cleanup = () => {
    observer.disconnect();
    element.removeEventListener(closeEvent, onClose);
    occludingSurfaces.delete(element);
    surfaces.delete(elements);
    notify();
    trackSurfaceLayout();
  };
  occludingSurfaces.add(element);
  element.addEventListener(closeEvent, onClose);
  // Observe every containing root: document observers cannot see shadow-tree
  // removals, and an outer host can itself be removed while its tree stays intact.
  let root = element.getRootNode();
  observer.observe(root, { childList: true, subtree: true });
  while (root instanceof ShadowRoot) {
    root = root.host.getRootNode();
    observer.observe(root, { childList: true, subtree: true });
  }
}

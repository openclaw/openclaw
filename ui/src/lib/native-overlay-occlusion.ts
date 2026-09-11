import { hasNativeBrowserBridge } from "../app/native-browser-host.ts";

const listeners = new Set<(occluded: boolean) => void>();
let activeOverlays = 0;

function notify(occluded: boolean) {
  for (const listener of listeners) {
    listener(occluded);
  }
}

/** Native web views sit above the page, including its browser top layer. */
export function acquireNativeOverlayOcclusion(): () => void {
  if (!hasNativeBrowserBridge()) {
    return () => {};
  }
  activeOverlays += 1;
  if (activeOverlays === 1) {
    notify(true);
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeOverlays -= 1;
    if (activeOverlays === 0) {
      notify(false);
    }
  };
}

export function subscribeNativeOverlayOcclusion(listener: (occluded: boolean) => void): () => void {
  if (!hasNativeBrowserBridge()) {
    listener(false);
    return () => {};
  }
  listeners.add(listener);
  listener(activeOverlays > 0);
  return () => {
    listeners.delete(listener);
  };
}

const occludingSurfaces = new WeakSet<HTMLElement>();

/** Keep a connected menu above native views through closing and owner removal. */
export function occludeNativeBrowserSurface(
  element: HTMLElement,
  closeEvent: "toggle" | "wa-after-hide" = "toggle",
) {
  if (!hasNativeBrowserBridge() || !element.isConnected || occludingSurfaces.has(element)) {
    return;
  }
  const release = acquireNativeOverlayOcclusion();
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
    release();
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

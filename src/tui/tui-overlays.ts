import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

type OverlayHost = Pick<TUI, "showOverlay" | "hideOverlay" | "hasOverlay" | "setFocus">;

/** Creates open/close handlers that restore focus when no overlay is active. */
export function createOverlayHandlers(host: OverlayHost, fallbackFocus: Component) {
  const closeOverlay = (handle?: OverlayHandle) => {
    if (handle) {
      handle.hide();
      if (!host.hasOverlay()) {
        host.setFocus(fallbackFocus);
      }
      return;
    }
    if (host.hasOverlay()) {
      host.hideOverlay();
      return;
    }
    host.setFocus(fallbackFocus);
  };

  return { openOverlay: host.showOverlay.bind(host), closeOverlay };
}

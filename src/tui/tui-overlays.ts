import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

type OverlayHost = Pick<TUI, "showOverlay" | "hasOverlay" | "setFocus">;

/** Creates open/close handlers that restore focus when no overlay is active. */
export function createOverlayHandlers(host: OverlayHost, fallbackFocus: Component) {
  const closeOverlay = (handle: OverlayHandle) => {
    handle.hide();
    if (!host.hasOverlay()) {
      host.setFocus(fallbackFocus);
    }
  };

  return { openOverlay: host.showOverlay.bind(host), closeOverlay };
}

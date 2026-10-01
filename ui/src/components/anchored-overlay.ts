import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";

type AnchoredOverlaySide = "top" | "bottom" | "left" | "right";
type AnchoredOverlayAlignment = "start" | "center" | "end";
type AnchoredOverlayOptions = {
  alignment?: AnchoredOverlayAlignment;
  anchor?: Element;
};

const VIEWPORT_MARGIN = 8;
const VIEWPORT_SIDE_MARGIN = 12;

export function syncAnchoredOverlay(
  details: HTMLDetailsElement,
  preferredSide: AnchoredOverlaySide,
  options: AnchoredOverlayOptions = {},
): void {
  const anchor = details.querySelector<HTMLElement>(":scope > summary");
  const popup = details.querySelector<WaPopup>(":scope > wa-popup[data-anchored-overlay]");
  if (!anchor || !popup) {
    return;
  }
  configureAnchoredPopup(popup, options.anchor ?? anchor, preferredSide, options.alignment);
  popup.active = details.open;
}

/** Shared popup geometry; the caller owns opening, focus, and dismissal. */
export function configureAnchoredPopup(
  popup: WaPopup,
  anchor: Element,
  preferredSide: AnchoredOverlaySide,
  alignment: AnchoredOverlayAlignment = "start",
): void {
  popup.anchor = anchor;
  popup.placement = alignment === "center" ? preferredSide : `${preferredSide}-${alignment}`;
  popup.boundary = "viewport";
  // Fixed/top-layer menus escape the app's padding, but not its safe canvas.
  const shell = anchor.closest<HTMLElement>(".shell");
  popup.flipBoundary = shell ?? [];
  popup.shiftBoundary = shell ?? [];
  popup.autoSizeBoundary = shell ?? [];
  popup.distance = 6;
  popup.flip = true;
  popup.flipPadding = VIEWPORT_MARGIN;
  popup.shift = true;
  popup.shiftPadding = shell
    ? Number.parseFloat(getComputedStyle(shell).getPropertyValue("--shell-popup-inline-gutter")) ||
      VIEWPORT_SIDE_MARGIN
    : VIEWPORT_SIDE_MARGIN;
  popup.autoSize = "vertical";
  popup.autoSizePadding = VIEWPORT_MARGIN;
}

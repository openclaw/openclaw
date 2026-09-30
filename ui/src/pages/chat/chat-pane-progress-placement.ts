import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  isSidebarSlotVisible,
  sidebarMainPanel,
  sidebarActivePanel,
  type SidebarLayout,
} from "./sidebar-layout.ts";

/** Geometry is presentation-only; resource tabs keep ownership of the saved layout. */
export function resolveChatProgressPlacement(params: {
  showProgress: boolean;
  preferFloating: boolean;
  layout: SidebarLayout;
  paneWidth: number;
  compact: boolean;
}): "composer" | "floating" | "hidden" {
  if (!params.showProgress || !isSidebarSlotVisible(params.layout, "conversation")) {
    return "hidden";
  }
  return !params.preferFloating || params.compact || params.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX
    ? "composer"
    : "floating";
}

/** Only visible panel transitions collapse a manually reopened card, not data updates. */
export function progressNeighborPanelKey(layout: SidebarLayout): string {
  const main = sidebarMainPanel(layout);
  const active = sidebarActivePanel(layout);
  const mainKey = main && main.slot !== "conversation" ? main.id : "";
  const sideKey =
    layout.open && !layout.expanded
      ? active?.slot === "conversation"
        ? ""
        : (active?.id ?? "selector")
      : "";
  return mainKey || sideKey ? JSON.stringify([mainKey, sideKey]) : "";
}

import type {
  SidebarDock,
  SidebarLayout,
  SidebarPanel,
  SidebarSlotId,
} from "./sidebar-layout-types.ts";

export function cloneLayout(layout: SidebarLayout): SidebarLayout {
  return structuredClone(layout);
}

export const SIDEBAR_MIN_WIDTH_PX = 260;
export const SIDEBAR_MIN_HEIGHT_PX = 220;
const SIDEBAR_MAX_WIDTH_PX = 1_200;
const SIDEBAR_MAX_HEIGHT_PX = 800;
const SIDEBAR_MAIN_MIN_WIDTH_PX = 312;
export const SIDEBAR_NARROW_BREAKPOINT_PX = 680;
const SIDEBAR_DIVIDER_WIDTH_PX = 4;

export function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width));
}

export function clampHeight(height: number): number {
  return Math.min(SIDEBAR_MAX_HEIGHT_PX, Math.max(SIDEBAR_MIN_HEIGHT_PX, height));
}

export function sidebarDock(layout: SidebarLayout): SidebarDock {
  return layout.dock === "bottom" || layout.dock === "left" ? layout.dock : "right";
}

export function sidebarMainPanel(layout: SidebarLayout): SidebarPanel | undefined {
  return layout.columns[0]?.panels.find((panel) => panel.id === layout.mainPanelId);
}

export function sidebarSidePanels(layout: SidebarLayout): SidebarPanel[] {
  return layout.columns[0]?.panels.filter((panel) => panel.id !== layout.mainPanelId) ?? [];
}

export function sidebarActivePanel(layout: SidebarLayout): SidebarPanel | undefined {
  return sidebarSidePanels(layout).find((panel) => panel.id === layout.columns[0]?.activePanelId);
}

export function isSidebarSlotVisible(layout: SidebarLayout, slot: SidebarSlotId): boolean {
  if (layout.expanded && layout.expandedSide) {
    return layout.open === true && sidebarActivePanel(layout)?.slot === slot;
  }
  if ((sidebarMainPanel(layout)?.slot ?? "conversation") === slot) {
    return true;
  }
  return layout.open === true && !layout.expanded && sidebarActivePanel(layout)?.slot === slot;
}

export function fitSidebarLayout(
  layout: SidebarLayout,
  availableWidth: number,
): SidebarLayout | null {
  const next = cloneLayout(layout);
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return next;
  }
  const column = next.columns[0];
  if (!column) {
    return next;
  }
  next.columns = [column];
  if (sidebarDock(next) === "bottom") {
    column.height = clampHeight(column.height);
    return next;
  }
  const budget = availableWidth - SIDEBAR_MAIN_MIN_WIDTH_PX - SIDEBAR_DIVIDER_WIDTH_PX;
  if (SIDEBAR_MIN_WIDTH_PX > budget) {
    return null;
  }
  column.width = Math.min(availableWidth * 0.6, budget, clampWidth(column.width));
  return next;
}

export function isSidebarRegionCollapsed(_layout: SidebarLayout, availableWidth: number): boolean {
  return availableWidth < SIDEBAR_NARROW_BREAKPOINT_PX;
}

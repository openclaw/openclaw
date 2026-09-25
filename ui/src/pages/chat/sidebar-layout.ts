import {
  cloneLayout,
  clampWidth,
  clampHeight,
  sidebarDock,
  sidebarMainPanel,
  sidebarSidePanels,
  sidebarActivePanel,
  isSidebarSlotVisible,
} from "./sidebar-layout-geometry.ts";
import type {
  SidebarColumn,
  SidebarDock,
  SidebarLayout,
  SidebarSlotId,
} from "./sidebar-layout-types.ts";

export type {
  SidebarColumn,
  SidebarDock,
  SidebarLayout,
  SidebarPanel,
  SidebarSlotId,
} from "./sidebar-layout-types.ts";

export {
  sidebarDock,
  sidebarMainPanel,
  sidebarSidePanels,
  sidebarActivePanel,
  isSidebarSlotVisible,
  fitSidebarLayout,
  initializeBrowserSidebarWidth,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_MIN_HEIGHT_PX,
  SIDEBAR_NARROW_BREAKPOINT_PX,
} from "./sidebar-layout-geometry.ts";

const SIDEBAR_DEFAULT_WIDTH_PX = 480;
const SIDEBAR_DEFAULT_HEIGHT_PX = 360;
export const SIDEBAR_GEOMETRY_COMMIT_EVENT = "openclaw-sidebar-geometry-commit";

function createSidebarColumn(): SidebarColumn {
  return {
    id: "side-panel-column",
    side: "right",
    panels: [],
    activePanelId: "",
    height: SIDEBAR_DEFAULT_HEIGHT_PX,
    width: SIDEBAR_DEFAULT_WIDTH_PX,
    browserWidthPending: true,
  };
}

/** Logical presentation, independent of responsive/narrow viewport projection. */
export function sidebarDashboardPresentation(
  layout: SidebarLayout,
): "split" | "expanded" | undefined {
  if (!isSidebarSlotVisible(layout, "dashboard")) {
    return undefined;
  }
  return layout.expanded || layout.open !== true ? "expanded" : "split";
}

/** Open without changing panel identities, docking, dimensions, or other panel state. */
export function openDashboardPresentation(
  layout: SidebarLayout,
  presentation: "split" | "expanded",
): SidebarLayout {
  let next = openSlot(layout, "dashboard");
  if (presentation === "expanded") {
    const dashboard = next.columns[0]?.panels.find((panel) => panel.slot === "dashboard");
    if (dashboard) {
      next = promoteSidebarPanel(next, dashboard.id);
    }
  } else if (sidebarMainPanel(next)?.slot === "dashboard") {
    next = openSlot(next, "conversation");
  }
  return setSidebarExpanded(next, presentation === "expanded");
}

function nextPanelId(layout: SidebarLayout, slot: SidebarSlotId): string {
  const used = new Set(layout.columns.flatMap((column) => column.panels.map((panel) => panel.id)));
  if (!used.has(slot)) {
    return slot;
  }
  let suffix = 2;
  while (used.has(`${slot}-${suffix}`)) {
    suffix += 1;
  }
  return `${slot}-${suffix}`;
}

function removePanel(layout: SidebarLayout, panelId: string): void {
  for (const column of layout.columns) {
    const panelIndex = column.panels.findIndex((panel) => panel.id === panelId);
    if (panelIndex < 0) {
      continue;
    }
    const sideIndex = column.panels
      .filter((entry) => entry.id !== layout.mainPanelId)
      .findIndex((entry) => entry.id === panelId);
    column.panels.splice(panelIndex, 1);
    if (column.activePanelId === panelId) {
      const sidePanels = column.panels.filter((entry) => entry.id !== layout.mainPanelId);
      column.activePanelId = sidePanels[Math.min(sideIndex, sidePanels.length - 1)]?.id ?? "";
    }
    return;
  }
}

export function ensureSidebarConversation(layout: SidebarLayout): SidebarLayout {
  const next = cloneLayout(layout);
  const column = (next.columns[0] ??= createSidebarColumn());
  let conversation = column.panels.find((panel) => panel.slot === "conversation");
  if (!conversation) {
    conversation = { id: nextPanelId(next, "conversation"), slot: "conversation" };
    column.panels.push(conversation);
  }
  next.mainPanelId = sidebarMainPanel(next)?.id ?? conversation.id;
  if (column.activePanelId === next.mainPanelId) {
    column.activePanelId = sidebarSidePanels(next)[0]?.id ?? "";
  }
  return next;
}

export function promoteSidebarPanel(layout: SidebarLayout, panelId: string): SidebarLayout {
  const target = layout.columns[0]?.panels.find((panel) => panel.id === panelId);
  if (!target || sidebarMainPanel(layout)?.id === panelId) {
    return cloneLayout(layout);
  }
  const next = ensureSidebarConversation(layout);
  const previousMainId = next.mainPanelId!;
  next.mainPanelId = panelId;
  next.columns[0]!.activePanelId = previousMainId;
  next.open = true;
  next.expanded = false;
  delete next.expandedSide;
  return next;
}

export function openSlot(layout: SidebarLayout, slot: SidebarSlotId): SidebarLayout {
  const next = cloneLayout(layout);
  if ((sidebarMainPanel(next)?.slot ?? "conversation") === slot) {
    return next.expandedSide ? setSidebarExpanded(next, false) : next;
  }
  const column =
    next.columns.find((entry) => entry.panels.some((panel) => panel.slot === slot)) ??
    (next.columns[0] ??= createSidebarColumn());
  let panel = column.panels.find((entry) => entry.slot === slot);
  if (!panel) {
    panel = { id: nextPanelId(next, slot), slot };
    column.panels.push(panel);
  }
  column.activePanelId = panel.id;
  next.open = true;
  if (next.expanded) {
    next.expanded = false;
    delete next.expandedSide;
  }
  return next;
}

export function closeSlot(layout: SidebarLayout, slot: SidebarSlotId): SidebarLayout {
  let next = cloneLayout(layout);
  const panel = next.columns
    .flatMap((column) => column.panels)
    .find((entry) => entry.slot === slot);
  if (panel) {
    if (next.expandedSide && panel.id === sidebarActivePanel(next)?.id) {
      next = setSidebarExpanded(next, false);
    }
    if (slot === "conversation") {
      if (panel.id !== next.mainPanelId) {
        next.open = false;
      }
      return next;
    }
    if (panel.id === next.mainPanelId) {
      next = ensureSidebarConversation(next);
      next.mainPanelId = next.columns[0]!.panels.find((entry) => entry.slot === "conversation")!.id;
    }
    removePanel(next, panel.id);
    const column = next.columns[0];
    if (column && !sidebarActivePanel(next)) {
      column.activePanelId = sidebarSidePanels(next)[0]?.id ?? "";
    }
    if (sidebarSidePanels(next).length === 0) {
      next.open = false;
    }
  }
  if (next.columns.length === 0) {
    next.open = false;
  }
  return next;
}

export function activatePanel(layout: SidebarLayout, panelId: string): SidebarLayout {
  const next = cloneLayout(layout);
  const column = next.columns.find((entry) => entry.panels.some((panel) => panel.id === panelId));
  if (column && panelId !== next.mainPanelId) {
    column.activePanelId = panelId;
    next.open = true;
    if (next.expanded) {
      next.expanded = false;
      delete next.expandedSide;
    }
  }
  return next;
}

export function reorderPanel(
  layout: SidebarLayout,
  panelId: string,
  targetPanelId: string,
  placement: "before" | "after",
): SidebarLayout {
  const next = cloneLayout(layout);
  const panels = next.columns[0]?.panels;
  if (!panels || panelId === targetPanelId) {
    return next;
  }
  const panelIndex = panels.findIndex((panel) => panel.id === panelId);
  const targetIndex = panels.findIndex((panel) => panel.id === targetPanelId);
  if (panelIndex < 0 || targetIndex < 0) {
    return next;
  }
  const [panel] = panels.splice(panelIndex, 1);
  const settledTargetIndex = panels.findIndex((entry) => entry.id === targetPanelId);
  panels.splice(settledTargetIndex + (placement === "after" ? 1 : 0), 0, panel!);
  return next;
}

export function setSidebarOpen(layout: SidebarLayout, open: boolean): SidebarLayout {
  const next = cloneLayout(layout);
  if (open) {
    next.columns[0] ??= createSidebarColumn();
    if (next.expanded) {
      next.expanded = false;
      delete next.expandedSide;
    }
  }
  next.open = open;
  if (!open && next.expandedSide) {
    next.expanded = false;
    delete next.expandedSide;
  }
  return next;
}

export function setSidebarExpanded(layout: SidebarLayout, expanded: boolean): SidebarLayout {
  // Restore split must reveal the side even when focus began with that panel closed.
  const next = cloneLayout(layout);
  delete next.expandedSide;
  return { ...next, expanded, ...(expanded ? { open: true } : {}) };
}

/** Focus in place: restoring must not leave the main and side views swapped. */
export function toggleSidebarPanelExpanded(layout: SidebarLayout, panelId: string): SidebarLayout {
  if (!sidebarSidePanels(layout).some((panel) => panel.id === panelId)) {
    return cloneLayout(layout);
  }
  if (layout.expanded && layout.expandedSide && sidebarActivePanel(layout)?.id === panelId) {
    return setSidebarExpanded(layout, false);
  }
  const next = activatePanel(ensureSidebarConversation(layout), panelId);
  next.expanded = true;
  next.expandedSide = true;
  return next;
}

export function setSidebarDock(layout: SidebarLayout, dock: SidebarDock): SidebarLayout {
  return { ...cloneLayout(layout), dock };
}

export function resizeSidebarPanel(
  layout: SidebarLayout,
  columnId: string,
  size: number,
): SidebarLayout {
  const next = cloneLayout(layout);
  const column = next.columns.find((entry) => entry.id === columnId);
  if (column && Number.isFinite(size)) {
    if (sidebarDock(next) === "bottom") {
      column.height = clampHeight(size);
    } else {
      column.width = clampWidth(size);
      delete column.browserWidthPending;
    }
  }
  return next;
}

export { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";

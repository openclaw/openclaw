import {
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

// Layout edits mutate containers and launcher state; panel records are immutable.
function editSidebarLayout(layout: SidebarLayout): SidebarLayout {
  return {
    ...layout,
    columns: layout.columns.map((column) => ({ ...column, panels: [...column.panels] })),
    ...(layout.newTab ? { newTab: { ...layout.newTab } } : {}),
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

function nextPanelId(layout: SidebarLayout, slot: string): string {
  const used = new Set(layout.columns[0]?.panels.map((panel) => panel.id));
  if (layout.newTab) {
    used.add(layout.newTab.id);
  }
  if (!used.has(slot)) {
    return slot;
  }
  let suffix = 2;
  while (used.has(`${slot}-${suffix}`)) {
    suffix += 1;
  }
  return `${slot}-${suffix}`;
}

/** Ordered side tab identities; resource enumeration stays in sidebarSidePanels. */
export function sidebarSideTabIds(layout: SidebarLayout): string[] {
  const ids = sidebarSidePanels(layout).map((panel) => panel.id);
  if (layout.newTab) {
    ids.splice(layout.newTab.index, 0, layout.newTab.id);
  }
  return ids;
}

export function isSidebarNewTabActive(layout: SidebarLayout): boolean {
  return layout.newTab !== undefined && layout.columns[0]?.activePanelId === layout.newTab.id;
}

function removePanel(layout: SidebarLayout, panelId: string, sideIds: string[]): void {
  const column = layout.columns[0];
  const panelIndex = column?.panels.findIndex((panel) => panel.id === panelId) ?? -1;
  if (!column || panelIndex < 0) {
    return;
  }
  const sideIndex = sideIds.indexOf(panelId);
  column.panels.splice(panelIndex, 1);
  const remainingSideIds = sideIds.filter((id) => id !== panelId && id !== layout.mainPanelId);
  if (layout.newTab) {
    layout.newTab.index = remainingSideIds.indexOf(layout.newTab.id);
  }
  if (column.activePanelId === panelId) {
    column.activePanelId = remainingSideIds[Math.min(sideIndex, remainingSideIds.length - 1)] ?? "";
  }
}

export function ensureSidebarConversation(layout: SidebarLayout): SidebarLayout {
  const next = editSidebarLayout(layout);
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
    return layout;
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

function selectPanel(layout: SidebarLayout, column: SidebarColumn, panelId: string): void {
  column.activePanelId = panelId;
  layout.open = true;
  if (layout.expanded) {
    layout.expanded = false;
    delete layout.expandedSide;
  }
}

/** Explicit + action only; an empty open container does not create a tab. */
export function openSidebarNewTab(
  layout: SidebarLayout,
  options?: { returnPanelId?: string },
): SidebarLayout {
  const next = ensureSidebarConversation(layout);
  next.newTab ??= {
    id: nextPanelId(next, "new-tab"),
    index: sidebarSidePanels(next).length,
  };
  // A retained launcher can be reopened from another real panel. Repeated + on
  // the launcher itself keeps its last origin rather than making a self-return.
  const origin = next.columns[0]!.panels.find((panel) => panel.id === options?.returnPanelId);
  if (origin) {
    next.newTab.returnPanelId = origin.id;
  }
  selectPanel(next, next.columns[0]!, next.newTab.id);
  return next;
}

export function closeSidebarNewTab(layout: SidebarLayout): SidebarLayout {
  const next = editSidebarLayout(layout);
  const tab = next.newTab;
  if (!tab) {
    return next;
  }
  if (isSidebarNewTabActive(next)) {
    const panels = sidebarSidePanels(next);
    next.columns[0]!.activePanelId =
      next.columns[0]!.panels.find((panel) => panel.id === tab.returnPanelId)?.id ??
      panels[Math.min(tab.index, panels.length - 1)]?.id ??
      "";
    if (next.expandedSide) {
      next.expanded = false;
      delete next.expandedSide;
    }
  }
  delete next.newTab;
  if (sidebarSidePanels(next).length === 0) {
    next.open = false;
  }
  return next;
}

/** Finish a successful native open; existing panels keep their own identity/order. */
export function replaceSidebarNewTab(
  before: SidebarLayout,
  opened: SidebarLayout,
  slot: SidebarSlotId,
): SidebarLayout {
  const next = editSidebarLayout(opened);
  const tab = before.newTab;
  const column = next.columns[0];
  const panel = column?.panels.find((entry) => entry.slot === slot);
  if (!tab || next.newTab?.id !== tab.id || !column || !panel) {
    return next;
  }
  if (!before.columns[0]?.panels.some((entry) => entry.id === panel.id)) {
    column.panels.splice(column.panels.indexOf(panel), 1);
    const target = sidebarSidePanels(next)[tab.index];
    column.panels.splice(target ? column.panels.indexOf(target) : column.panels.length, 0, panel);
  }
  delete next.newTab;
  return next;
}

/** Called only after native close guards settle. Never discard a remaining resource. */
export function finishSidebarCloseAll(layout: SidebarLayout): SidebarLayout | null {
  if (sidebarSidePanels(layout).some((panel) => panel.slot !== "conversation")) {
    return null;
  }
  return setSidebarOpen(closeSidebarNewTab(layout), true);
}

export function openSlot(layout: SidebarLayout, slot: SidebarSlotId): SidebarLayout {
  const next = editSidebarLayout(layout);
  if ((sidebarMainPanel(next)?.slot ?? "conversation") === slot) {
    return next.expandedSide ? setSidebarExpanded(next, false) : next;
  }
  const column = (next.columns[0] ??= createSidebarColumn());
  let panel = column.panels.find((entry) => entry.slot === slot);
  if (!panel) {
    panel = { id: nextPanelId(next, slot), slot };
    column.panels.push(panel);
  }
  selectPanel(next, column, panel.id);
  return next;
}

export function closeSlot(layout: SidebarLayout, slot: SidebarSlotId): SidebarLayout {
  if (!layout.columns[0]?.panels.some((panel) => panel.slot === slot)) {
    return layout.columns.length === 0 && layout.open !== false
      ? { ...layout, open: false }
      : layout;
  }
  let next = editSidebarLayout(layout);
  const panel = next.columns[0]?.panels.find((entry) => entry.slot === slot);
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
    // Capture side order before Chat becomes main and leaves the tab strip.
    const sideIds = sidebarSideTabIds(next);
    if (panel.id === next.mainPanelId) {
      next = ensureSidebarConversation(next);
      next.mainPanelId = next.columns[0]!.panels.find((entry) => entry.slot === "conversation")!.id;
    }
    removePanel(next, panel.id, sideIds);
    const column = next.columns[0];
    if (column && !sidebarActivePanel(next) && !isSidebarNewTabActive(next)) {
      column.activePanelId = sidebarSidePanels(next)[0]?.id ?? "";
    }
    if (sidebarSidePanels(next).length === 0 && !next.newTab) {
      next.open = false;
    }
  }
  if (next.columns.length === 0) {
    next.open = false;
  }
  return next;
}

export function activatePanel(layout: SidebarLayout, panelId: string): SidebarLayout {
  const next = editSidebarLayout(layout);
  const column = next.columns[0];
  if (
    column &&
    (column.panels.some((panel) => panel.id === panelId) || next.newTab?.id === panelId) &&
    panelId !== next.mainPanelId
  ) {
    selectPanel(next, column, panelId);
  }
  return next;
}

export function reorderPanel(
  layout: SidebarLayout,
  panelId: string,
  targetPanelId: string,
  placement: "before" | "after",
): SidebarLayout {
  const next = editSidebarLayout(layout);
  const panels = next.columns[0]?.panels;
  if (!panels || panelId === targetPanelId) {
    return next;
  }
  if (next.newTab && panelId !== next.mainPanelId && targetPanelId !== next.mainPanelId) {
    const ids = sidebarSideTabIds(next);
    const index = ids.indexOf(panelId);
    if (index < 0 || !ids.includes(targetPanelId)) {
      return next;
    }
    ids.splice(index, 1);
    ids.splice(ids.indexOf(targetPanelId) + (placement === "after" ? 1 : 0), 0, panelId);
    next.newTab.index = ids.indexOf(next.newTab.id);
    const ordered = ids.filter((id) => id !== next.newTab!.id);
    const byId = new Map(panels.map((panel) => [panel.id, panel]));
    let sideIndex = 0;
    next.columns[0]!.panels = panels.map((panel) =>
      panel.id === next.mainPanelId ? panel : byId.get(ordered[sideIndex++]!)!,
    );
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
  const next = { ...layout, columns: [...layout.columns] };
  if (open) {
    next.columns[0] ??= createSidebarColumn();
  }
  next.open = open;
  if (open ? next.expanded : next.expandedSide) {
    next.expanded = false;
    delete next.expandedSide;
  }
  return next;
}

export function setSidebarExpanded(layout: SidebarLayout, expanded: boolean): SidebarLayout {
  // Restore split must reveal the side even when focus began with that panel closed.
  const next = { ...layout };
  delete next.expandedSide;
  return { ...next, expanded, open: true };
}

/**
 * Focus in place without swapping main and side views. Omit panelId to expand
 * the container, including its empty launcher, without changing the selection.
 */
export function toggleSidebarPanelExpanded(layout: SidebarLayout, panelId?: string): SidebarLayout {
  if (
    panelId !== undefined &&
    panelId !== layout.newTab?.id &&
    !sidebarSidePanels(layout).some((panel) => panel.id === panelId)
  ) {
    return layout;
  }
  if (
    layout.expanded &&
    layout.expandedSide &&
    (panelId === undefined || layout.columns[0]?.activePanelId === panelId)
  ) {
    return setSidebarExpanded(layout, false);
  }
  const next =
    panelId === undefined
      ? ensureSidebarConversation(layout)
      : activatePanel(ensureSidebarConversation(layout), panelId);
  next.open = true;
  next.expanded = true;
  next.expandedSide = true;
  return next;
}

const narrowPresentations = new WeakMap<SidebarLayout, SidebarLayout>();

/**
 * How a narrow pane shows a layout. It can only stack its side panel under the
 * main view, which leaves a list-and-detail panel too little room, so an open
 * Subagents or Processes panel is shown focused in place. Mobile chrome uses
 * this presentation for every panel. The saved layout is unchanged, so a wider
 * pane shows the original split again.
 */
export function presentNarrowSidebarLayout(
  layout: SidebarLayout,
  options?: { allPanels: boolean },
): SidebarLayout {
  const slot =
    layout.open === true && !layout.expanded ? sidebarActivePanel(layout)?.slot : undefined;
  // Phone layouts show the selected side view, including Chat beside a page.
  if (!slot || (!options?.allPanels && slot !== "subagents" && slot !== "processes")) {
    return layout;
  }
  let presented = narrowPresentations.get(layout);
  if (!presented) {
    presented = { ...layout, expanded: true, expandedSide: true };
    narrowPresentations.set(layout, presented);
  }
  return presented;
}

export function setSidebarDock(layout: SidebarLayout, dock: SidebarDock): SidebarLayout {
  return { ...layout, dock };
}

export function resizeSidebarPanel(
  layout: SidebarLayout,
  columnId: string,
  size: number,
): SidebarLayout {
  if (!Number.isFinite(size)) {
    return layout;
  }
  return {
    ...layout,
    columns: layout.columns.map((column) => {
      if (column.id !== columnId) {
        return column;
      }
      if (sidebarDock(layout) === "bottom") {
        return { ...column, height: clampHeight(size) };
      }
      const next = { ...column, width: clampWidth(size) };
      delete next.browserWidthPending;
      return next;
    }),
  };
}

export { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";

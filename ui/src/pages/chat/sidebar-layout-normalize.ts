import { isRecord, normalizeOptionalString, readStringValue } from "@openclaw/normalization-core";
import { clampHeight, clampWidth } from "./sidebar-layout-geometry.ts";
import type { SidebarLayout, SidebarPanel, SidebarSlotId } from "./sidebar-layout-types.ts";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 360;

function isPluginSlotId(value: unknown): value is `plugin:${string}/${string}` {
  return (
    typeof value === "string" &&
    /^plugin:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  );
}

function normalizeSlotId(value: unknown): SidebarSlotId | null {
  // Stable releases persisted dashboard panels as `chat`; normalize that
  // storage contract here so upgrades retain the selected panel and layout.
  if (value === "chat") {
    return "dashboard";
  }
  return value === "browser" ||
    value === "link-reader" ||
    value === "companion" ||
    value === "conversation" ||
    value === "dashboard" ||
    value === "desktop" ||
    value === "detail" ||
    value === "discussion" ||
    value === "portal" ||
    value === "tasks" ||
    value === "terminal" ||
    value === "workspace" ||
    isPluginSlotId(value)
    ? value
    : null;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix++}`;
  }
  used.add(id);
  return id;
}

export function normalizeSidebarLayout(value: unknown): SidebarLayout {
  if (!isRecord(value) || !Array.isArray(value.columns)) {
    return { columns: [], open: false, expanded: false };
  }
  let columnId: string | undefined;
  const usedPanelIds = new Set<string>();
  const usedSlots = new Set<SidebarSlotId>();
  const panels: SidebarPanel[] = [];
  const requestedMainId = readStringValue(value.mainPanelId)?.trim();
  let mainPanelId: string | undefined;
  let activePanelId = "";
  let width = DEFAULT_WIDTH;
  let browserWidthPending: true | undefined;
  let height = DEFAULT_HEIGHT;
  for (const rawColumn of value.columns) {
    if (
      !isRecord(rawColumn) ||
      (rawColumn.side !== "left" && rawColumn.side !== "right") ||
      !Array.isArray(rawColumn.panels)
    ) {
      continue;
    }
    columnId ??= normalizeOptionalString(rawColumn.id) ?? "column";
    const requestedActiveId = normalizeOptionalString(rawColumn.activePanelId) ?? "";
    let columnActivePanelId: string | undefined;
    for (const rawPanel of rawColumn.panels) {
      if (!isRecord(rawPanel)) {
        continue;
      }
      const sourceSlot = normalizeSlotId(rawPanel.slot);
      const taskId = normalizeOptionalString(rawPanel.taskId);
      // Saved layouts from the previous task inspector retain the ID on Review.
      // Normalize that persisted data once; runtime selection belongs only to Tasks.
      const legacyTask = sourceSlot === "detail" && taskId !== undefined;
      const slot = legacyTask ? "tasks" : sourceSlot;
      if (!slot) {
        continue;
      }
      if (usedSlots.has(slot)) {
        const existing = panels.find((panel) => panel.slot === slot)!;
        if (slot === "tasks") {
          if (taskId && (!legacyTask || !existing.taskId)) {
            existing.taskId = taskId;
          }
          const sourceId = normalizeOptionalString(rawPanel.id) ?? sourceSlot;
          if (sourceId === requestedActiveId) {
            columnActivePanelId = existing.id;
          }
          if (sourceId === requestedMainId) {
            mainPanelId = existing.id;
          }
        }
        continue;
      }
      const rawPanelId = normalizeOptionalString(rawPanel.id) ?? "";
      const panelId = uniqueId(rawPanelId || slot, usedPanelIds);
      const sourceId = rawPanelId || (rawPanel.slot === "chat" ? "chat" : sourceSlot);
      if (sourceId === requestedActiveId) {
        columnActivePanelId ??= panelId;
      }
      if (sourceId === requestedMainId) {
        mainPanelId ??= panelId;
      }
      usedSlots.add(slot);
      const environmentId = normalizeOptionalString(rawPanel.environmentId);
      const portalId = normalizeOptionalString(rawPanel.portalId);
      panels.push({
        id: panelId,
        slot,
        ...(slot === "tasks" && taskId ? { taskId } : {}),
        ...((slot === "desktop" || (slot === "portal" && !portalId)) && environmentId
          ? { environmentId }
          : {}),
        ...(slot === "portal" && portalId ? { portalId } : {}),
      });
    }
    activePanelId = columnActivePanelId ?? activePanelId;
    width =
      typeof rawColumn.width === "number" && Number.isFinite(rawColumn.width)
        ? clampWidth(rawColumn.width)
        : width;
    browserWidthPending = rawColumn.browserWidthPending === true ? true : undefined;
    height =
      typeof rawColumn.height === "number" && Number.isFinite(rawColumn.height)
        ? clampHeight(rawColumn.height)
        : height;
  }
  let conversation = panels.find((panel) => panel.slot === "conversation");
  // Legacy expansion only hid chat while the side panel was open. A minimized
  // panel must not displace chat just because its old expanded flag was retained.
  if (value.mainPanelId === undefined && value.expanded === true && value.open !== false) {
    mainPanelId = panels.find((panel) => panel.id === activePanelId)?.id ?? panels[0]?.id;
  }
  if (mainPanelId || conversation || requestedMainId !== undefined || value.expanded === true) {
    if (!conversation) {
      conversation = {
        id: uniqueId("conversation", usedPanelIds),
        slot: "conversation",
      };
      panels.push(conversation);
    }
    mainPanelId ??= conversation.id;
  }
  const activeSidePanel =
    panels.find((panel) => panel.id === activePanelId && panel.id !== mainPanelId) ??
    (conversation && conversation.id !== mainPanelId
      ? conversation
      : panels.find((panel) => panel.id !== mainPanelId));
  const columns =
    columnId || panels.length > 0 || value.open === true
      ? [
          {
            id: columnId ?? "side-panel-column",
            side: "right" as const,
            panels,
            activePanelId: activeSidePanel?.id ?? "",
            height,
            width,
            ...(browserWidthPending ? { browserWidthPending } : {}),
          },
        ]
      : [];
  return {
    columns,
    ...(mainPanelId ? { mainPanelId } : {}),
    dock: value.dock === "bottom" || value.dock === "left" ? value.dock : "right",
    open: typeof value.open === "boolean" ? value.open : columns.length > 0,
    expanded: value.expanded === true,
    ...(value.dashboardPresentationOverride === null ||
    value.dashboardPresentationOverride === "split" ||
    value.dashboardPresentationOverride === "expanded"
      ? { dashboardPresentationOverride: value.dashboardPresentationOverride }
      : {}),
    ...(value.expanded === true &&
    value.expandedSide === true &&
    value.open !== false &&
    activeSidePanel
      ? { expandedSide: true }
      : {}),
    ...(value.resourceAutoOpenDismissed === true ? { resourceAutoOpenDismissed: true } : {}),
  };
}

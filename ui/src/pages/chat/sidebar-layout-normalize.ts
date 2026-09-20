import { isRecord, normalizeOptionalString, readStringValue } from "@openclaw/normalization-core";
import type { SidebarLayout, SidebarPanel, SidebarSlotId } from "./sidebar-layout-types.ts";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 220;
const MAX_WIDTH = 1_200;
const MAX_HEIGHT = 800;

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

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

function clampHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height));
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
      const slot = normalizeSlotId(rawPanel.slot);
      if (!slot || usedSlots.has(slot)) {
        continue;
      }
      const rawPanelId = normalizeOptionalString(rawPanel.id) ?? "";
      const panelId = uniqueId(rawPanelId || slot, usedPanelIds);
      const sourceId = rawPanelId || (rawPanel.slot === "chat" ? "chat" : slot);
      if (sourceId === requestedActiveId) {
        columnActivePanelId ??= panelId;
      }
      if (sourceId === requestedMainId) {
        mainPanelId ??= panelId;
      }
      usedSlots.add(slot);
      panels.push({
        id: panelId,
        slot,
        ...(slot === "detail" && normalizeOptionalString(rawPanel.taskId)
          ? { taskId: normalizeOptionalString(rawPanel.taskId) }
          : {}),
        ...((slot === "desktop" ||
          (slot === "portal" && !normalizeOptionalString(rawPanel.portalId))) &&
        normalizeOptionalString(rawPanel.environmentId)
          ? { environmentId: normalizeOptionalString(rawPanel.environmentId) }
          : {}),
        ...(slot === "portal" && normalizeOptionalString(rawPanel.portalId)
          ? { portalId: normalizeOptionalString(rawPanel.portalId) }
          : {}),
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
  };
}

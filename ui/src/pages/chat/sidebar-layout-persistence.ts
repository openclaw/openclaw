import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";
import type { SidebarLayout } from "./sidebar-layout.ts";

export type SidebarSessionLayouts = Record<string, SidebarLayout>;
export type SidebarSessionActivePanels = Record<string, string>;

const MAX_SIDEBAR_SESSION_LAYOUTS = 500;

export function normalizeSidebarSessionLayouts(value: unknown): SidebarSessionLayouts {
  const layouts: SidebarSessionLayouts = {};
  for (const [sessionKey, rawLayout] of Object.entries(asNonArrayRecord(value)).slice(
    -MAX_SIDEBAR_SESSION_LAYOUTS,
  )) {
    const key = sessionKey.trim();
    if (!key) {
      continue;
    }
    layouts[key] = normalizeSidebarLayout(rawLayout);
  }
  return layouts;
}

export function updateSidebarSessionLayout(
  current: SidebarSessionLayouts | undefined,
  sessionKey: string,
  layout: SidebarLayout,
  options?: {
    geometryOnly?: boolean;
    dashboardPresentationOverride?: SidebarLayout["dashboardPresentationOverride"];
  },
): SidebarSessionLayouts {
  const key = sessionKey.trim();
  const layouts = normalizeSidebarSessionLayouts(current);
  if (!key) {
    return layouts;
  }
  const previous = layouts[key];
  const normalized = normalizeSidebarLayout(layout);
  // Width/dock changes must not save a route/tool’s one-off presentation over
  // an existing preference, particularly an unmarked legacy layout.
  const next =
    options?.geometryOnly && previous
      ? {
          ...previous,
          dock: normalized.dock,
          columns: previous.columns.map((column) => {
            const geometry = normalized.columns.find((candidate) => candidate.id === column.id);
            return geometry
              ? {
                  ...column,
                  width: geometry.width,
                  height: geometry.height,
                  browserWidthPending: geometry.browserWidthPending,
                }
              : column;
          }),
        }
      : normalized;
  delete layouts[key];
  layouts[key] = normalizeSidebarLayout({
    ...next,
    // Only an explicit presentation choice may replace the stored preference.
    // Other layout writes can carry stale metadata from a retained pane.
    dashboardPresentationOverride:
      options?.dashboardPresentationOverride !== undefined
        ? options.dashboardPresentationOverride
        : previous
          ? previous.dashboardPresentationOverride
          : null,
  });
  return Object.fromEntries(Object.entries(layouts).slice(-MAX_SIDEBAR_SESSION_LAYOUTS));
}

export function normalizeSidebarSessionActivePanels(value: unknown): SidebarSessionActivePanels {
  const selections: SidebarSessionActivePanels = {};
  for (const [sessionKey, panelId] of Object.entries(asNonArrayRecord(value)).slice(
    -MAX_SIDEBAR_SESSION_LAYOUTS,
  )) {
    const key = sessionKey.trim();
    const id = typeof panelId === "string" ? panelId.trim() : "";
    if (key && id) {
      selections[key] = id;
    }
  }
  return selections;
}

export function updateSidebarSessionActivePanel(
  current: SidebarSessionActivePanels | undefined,
  sessionKey: string,
  panelId: string,
): SidebarSessionActivePanels {
  const key = sessionKey.trim();
  const id = panelId.trim();
  const selections = normalizeSidebarSessionActivePanels(current);
  if (!key || !id) {
    return selections;
  }
  delete selections[key];
  selections[key] = id;
  return Object.fromEntries(Object.entries(selections).slice(-MAX_SIDEBAR_SESSION_LAYOUTS));
}

import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeWorkspace } from "./index.ts";
import type { WorkspaceDocument, WorkspaceTab, WorkspaceWidget } from "./types.ts";

export type WorkspaceHistoryEntry = { version: number; savedAt: string; bytes: number };
export type WorkspaceHistorySnapshot = { version: number; workspace: WorkspaceDocument };
type WorkspaceStructuralDiffKind =
  | "widget-added"
  | "widget-removed"
  | "widget-moved"
  | "widget-resized"
  | "widget-retitled"
  | "tab-added"
  | "tab-removed"
  | "tab-retitled";
type WorkspaceStructuralDiffEntry = {
  kind: WorkspaceStructuralDiffKind;
  creator: string | null;
  id: string;
  label: string;
  detail?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function loadHistoryList(
  client: GatewayBrowserClient | null,
): Promise<WorkspaceHistoryEntry[]> {
  if (!client) {
    return [];
  }
  const payload = await client.request("workspaces.history.list", {});
  const entries = isRecord(payload) && Array.isArray(payload.entries) ? payload.entries : [];
  return entries
    .filter(isRecord)
    .map((entry) => ({
      version: typeof entry.version === "number" ? entry.version : 0,
      savedAt: typeof entry.savedAt === "string" ? entry.savedAt : "",
      bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
    }))
    .filter((entry) => entry.version > 0 && entry.savedAt.length > 0 && entry.bytes > 0);
}

export async function loadHistorySnapshot(
  client: GatewayBrowserClient | null,
  version: number,
): Promise<WorkspaceDocument | null> {
  if (!client) {
    return null;
  }
  const payload = await client.request("workspaces.history.get", { version });
  const doc = isRecord(payload) && "doc" in payload ? payload.doc : payload;
  return normalizeWorkspace(doc);
}

type WidgetLocation = { widget: WorkspaceWidget; tabSlug: string };

function indexWidgets(workspace: WorkspaceDocument): Map<string, WidgetLocation> {
  const index = new Map<string, WidgetLocation>();
  for (const tab of workspace.tabs) {
    for (const widget of tab.widgets) {
      index.set(widget.id, { widget, tabSlug: tab.slug });
    }
  }
  return index;
}

function indexTabs(workspace: WorkspaceDocument): Map<string, WorkspaceTab> {
  return new Map(workspace.tabs.map((tab) => [tab.slug, tab]));
}

function samePosition(a: WorkspaceWidget, b: WorkspaceWidget): boolean {
  return a.grid.x === b.grid.x && a.grid.y === b.grid.y;
}

function sameSize(a: WorkspaceWidget, b: WorkspaceWidget): boolean {
  return a.grid.w === b.grid.w && a.grid.h === b.grid.h;
}

export function computeWorkspaceStructuralDiff(
  snapshot: WorkspaceDocument,
  current: WorkspaceDocument,
): WorkspaceStructuralDiffEntry[] {
  const entries: WorkspaceStructuralDiffEntry[] = [];
  const snapshotTabs = indexTabs(snapshot);
  const currentTabs = indexTabs(current);

  for (const [slug, tab] of currentTabs) {
    if (!snapshotTabs.has(slug)) {
      entries.push({
        kind: "tab-added",
        creator: tab.createdBy ?? null,
        id: slug,
        label: tab.title,
      });
    }
  }
  for (const [slug, tab] of snapshotTabs) {
    const currentTab = currentTabs.get(slug);
    if (!currentTab) {
      entries.push({
        kind: "tab-removed",
        creator: tab.createdBy ?? null,
        id: slug,
        label: tab.title,
      });
      continue;
    }
    if (currentTab.title !== tab.title) {
      entries.push({
        kind: "tab-retitled",
        creator: currentTab.createdBy ?? tab.createdBy ?? null,
        id: slug,
        label: currentTab.title,
        detail: `${tab.title} → ${currentTab.title}`,
      });
    }
  }

  const snapshotWidgets = indexWidgets(snapshot);
  const currentWidgets = indexWidgets(current);
  for (const [id, location] of currentWidgets) {
    if (!snapshotWidgets.has(id)) {
      entries.push({
        kind: "widget-added",
        creator: location.widget.createdBy ?? null,
        id,
        label: location.widget.title || id,
      });
    }
  }
  for (const [id, location] of snapshotWidgets) {
    const currentLocation = currentWidgets.get(id);
    if (!currentLocation) {
      entries.push({
        kind: "widget-removed",
        creator: location.widget.createdBy ?? null,
        id,
        label: location.widget.title || id,
      });
      continue;
    }
    const before = location.widget;
    const after = currentLocation.widget;
    if (location.tabSlug !== currentLocation.tabSlug || !samePosition(before, after)) {
      entries.push({
        kind: "widget-moved",
        creator: after.createdBy ?? null,
        id,
        label: after.title || id,
        ...(location.tabSlug !== currentLocation.tabSlug
          ? { detail: `${location.tabSlug} → ${currentLocation.tabSlug}` }
          : {}),
      });
    }
    if (!sameSize(before, after)) {
      entries.push({
        kind: "widget-resized",
        creator: after.createdBy ?? null,
        id,
        label: after.title || id,
        detail: `${before.grid.w}×${before.grid.h} → ${after.grid.w}×${after.grid.h}`,
      });
    }
    if (before.title !== after.title) {
      entries.push({
        kind: "widget-retitled",
        creator: after.createdBy ?? null,
        id,
        label: after.title || id,
        detail: `${before.title || id} → ${after.title || id}`,
      });
    }
  }
  return entries;
}

export function groupDiffByCreator(
  entries: WorkspaceStructuralDiffEntry[],
): Array<{ creator: string | null; entries: WorkspaceStructuralDiffEntry[] }> {
  const groups = new Map<string | null, WorkspaceStructuralDiffEntry[]>();
  for (const entry of entries) {
    const grouped = groups.get(entry.creator);
    if (grouped) {
      grouped.push(entry);
    } else {
      groups.set(entry.creator, [entry]);
    }
  }
  return [...groups.entries()].map(([creator, grouped]) => ({ creator, entries: grouped }));
}

function hasWidget(workspace: WorkspaceDocument, widgetId: string): boolean {
  return workspace.tabs.some((tab) => tab.widgets.some((widget) => widget.id === widgetId));
}

type WorkspaceFirstSeen =
  | { kind: "exact"; version: number }
  | { kind: "range"; afterVersion: number; byVersion: number }
  | { kind: "unknown" };

export function firstSeenVersion(
  widgetId: string,
  snapshots: readonly WorkspaceHistorySnapshot[],
): WorkspaceFirstSeen {
  const ordered = snapshots.toSorted((a, b) => a.version - b.version);
  const firstIndex = ordered.findIndex((snapshot) => hasWidget(snapshot.workspace, widgetId));
  if (firstIndex <= 0) {
    return { kind: "unknown" };
  }
  const first = ordered[firstIndex]!;
  const previous = ordered[firstIndex - 1]!;
  if (first.version === previous.version + 1) {
    return { kind: "exact", version: first.version };
  }
  return { kind: "range", afterVersion: previous.version, byVersion: first.version };
}

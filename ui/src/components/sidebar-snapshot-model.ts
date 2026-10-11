import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SidebarSnapshotModel, SidebarSnapshotSession } from "./sidebar-snapshot-data.ts";

export {
  parseSidebarSnapshot,
  type SidebarSnapshotModel,
  type SidebarSnapshotSession,
} from "./sidebar-snapshot-data.ts";

function containsIncognito(rows: readonly SidebarRecentSession[]): boolean {
  return rows.some(
    (row) => row.incognito || isIncognitoSessionKey(row.key) || containsIncognito(row.children),
  );
}

export function snapshotSessions(
  rows: readonly SidebarRecentSession[],
  presentation?: (
    row: SidebarRecentSession,
  ) => Pick<SidebarSnapshotSession, "snapshotSubtitle" | "childrenDisplayMode">,
): SidebarSnapshotSession[] {
  return rows
    .filter((row) => !row.incognito && !isIncognitoSessionKey(row.key))
    .map((row) => {
      const display = presentation?.(row);
      return {
        key: row.key,
        label: row.label,
        agentId: row.agentId,
        subtitle: row.subtitle,
        icon: row.icon,
        color: row.color,
        pinned: row.pinned,
        isChild: row.isChild,
        category: row.category,
        archived: row.archived,
        boardFace: row.boardFace,
        childrenDisplayMode: display?.childrenDisplayMode,
        // Parent attention can summarize private descendants even after their rows are omitted.
        snapshotSubtitle: containsIncognito(row.children) ? undefined : display?.snapshotSubtitle,
        children: snapshotSessions(row.children, presentation),
      };
    });
}

export function snapshotSections(
  source: SidebarVisibleSections["sections"],
  collapsedSections: ReadonlySet<string>,
  presentation?: Parameters<typeof snapshotSessions>[1],
) {
  const sections = source.flatMap((section) => {
    const rows = snapshotSessions(section.rows, presentation);
    if (section.rows.length > 0 && rows.length === 0) {
      return [];
    }
    return [
      {
        ...section,
        rows,
        ...(rows.length !== section.rows.length
          ? {
              totalRowCount: rows.length,
              visibleRowCount: Math.min(section.visibleRowCount, rows.length),
              collapsedVisibleRowCount: Math.min(section.collapsedVisibleRowCount, rows.length),
            }
          : {}),
      },
    ];
  });
  const retained = new Set<string>(sections.map((section) => section.id));
  return {
    sections,
    collapsedSections: [...collapsedSections].filter((id) => id === "online" || retained.has(id)),
  };
}

export function restoreSnapshotSections(
  model: SidebarSnapshotModel,
  selected: string,
): SidebarVisibleSections {
  const sections: SidebarVisibleSections["sections"] = [];
  for (const section of model.sections) {
    sections.push({
      ...section,
      rows: section.rows.map((row) => restoreSnapshotSession(row, selected)),
    });
  }
  return { sections, visibleRows: sections.flatMap((section) => section.rows) };
}

export function restoreSnapshotSession(
  row: SidebarSnapshotSession,
  selected: string,
): SidebarRecentSession {
  return {
    ...row,
    renameValue: row.label,
    active: row.key === selected,
    visuallyActive: row.key === selected,
    hasActiveRun: false,
    modelSelectionLocked: true,
    pinnable: false,
    cloudWorkerStopAction: null,
    hasAutomation: false,
    unread: false,
    attention: { kind: "none" },
    childSessionKeys: row.children.map((child) => child.key),
    children: row.children.map((child) => restoreSnapshotSession(child, selected)),
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
  };
}

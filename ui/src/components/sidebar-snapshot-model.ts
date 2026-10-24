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
  ) => Pick<
    SidebarSnapshotSession,
    "snapshotSubtitle" | "childrenDisplayMode" | "snapshotPresentation" | "participants"
  >,
): SidebarSnapshotSession[] {
  return rows
    .filter((row) => !row.incognito && !isIncognitoSessionKey(row.key))
    .map((row) => {
      const display = presentation?.(row);
      const privateChildren = containsIncognito([
        ...row.children,
        ...(row.unreadHiddenRuns ?? []),
        ...(row.subagentSummary?.unreadHiddenRuns ?? []),
      ]);
      return {
        key: row.key,
        label: row.label,
        agentId: row.agentId,
        worktreeId: row.worktreeId,
        subtitle: row.subtitle,
        icon: row.icon,
        color: row.color,
        pinned: row.pinned,
        isChild: row.isChild,
        category: row.category,
        archived: row.archived,
        boardFace: row.boardFace,
        unread: row.unread,
        hasActiveRun: row.hasActiveRun,
        isRunVisuallyActive: row.isRunVisuallyActive,
        status: row.status,
        hasAutomation: row.hasAutomation,
        runningChildCount: privateChildren ? 0 : row.runningChildCount,
        failedChildCount: privateChildren ? 0 : row.failedChildCount,
        unreadChildCount: privateChildren ? undefined : row.unreadChildCount,
        queuedChildCount: privateChildren ? undefined : row.queuedChildCount,
        attention: privateChildren ? row.ownAttention : row.attention,
        ownAttention: row.ownAttention,
        subagentSummary: privateChildren ? undefined : row.subagentSummary,
        participants: display?.participants ?? row.participants,
        participantCount: row.participantCount,
        snapshotPresentation: display?.snapshotPresentation,
        childrenDisplayMode: display?.childrenDisplayMode,
        childLoadParentKeys: row.childLoadParentKeys?.filter((key) => !isIncognitoSessionKey(key)),
        // Parent attention can summarize private descendants even after their rows are omitted.
        snapshotSubtitle: privateChildren ? undefined : display?.snapshotSubtitle,
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
    // Pinned and Online render outside the projected list sections.
    collapsedSections: [...collapsedSections].filter(
      (id) => id === "pinned" || id === "online" || retained.has(id),
    ),
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
    hasActiveRun: row.hasActiveRun ?? false,
    modelSelectionLocked: true,
    pinnable: false,
    cloudWorkerStopAction: null,
    hasAutomation: row.hasAutomation ?? false,
    unread: row.unread ?? false,
    attention: row.attention ?? { kind: "none" },
    childSessionKeys: row.children.map((child) => child.key),
    childLoadParentKeys: row.childLoadParentKeys ?? [],
    children: row.children.map((child) => restoreSnapshotSession(child, selected)),
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: row.runningChildCount ?? 0,
    failedChildCount: row.failedChildCount ?? 0,
  };
}

export function sidebarSnapshotAvatarUrls(model: SidebarSnapshotModel): string[] {
  const urls = [
    model.brand.avatar,
    model.footer?.avatarUrl,
    ...model.cards.map((card) => card.avatar),
    ...(model.avatarAgents ?? []).map((agent) => agent.avatar),
    ...[...model.onlineUsers, ...model.offlineUsers, ...(model.ownerOptions ?? [])].map(
      (user) => user.avatarUrl,
    ),
  ];
  const rows = [
    ...model.sessions,
    ...model.pages,
    ...model.pinnedSessions,
    ...model.sections.flatMap((section) => section.rows),
  ];
  for (const row of rows) {
    urls.push(
      row.snapshotPresentation?.owner?.avatarUrl,
      ...(row.participants ?? []).map((person) => person.avatarUrl),
      ...(row.snapshotPresentation?.viewers ?? []).map((user) => user.avatarUrl),
    );
    rows.push(...row.children);
  }
  return urls.filter((url): url is string => Boolean(url));
}

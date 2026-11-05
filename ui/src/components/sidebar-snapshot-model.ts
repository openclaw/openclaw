import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { parseSidebarEntry } from "../app-navigation.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import type { SidebarSnapshotModel, SidebarSnapshotSession } from "./sidebar-snapshot-data.ts";

export {
  parseSidebarSnapshot,
  type SidebarSnapshotModel,
  type SidebarSnapshotSession,
} from "./sidebar-snapshot-data.ts";

export function snapshotIssuesCount(entries: readonly SidebarInboxEntry[]): number {
  return entries.filter((entry) => {
    const keys =
      entry.type === "outbox"
        ? [entry.sessionKey]
        : entry.type === "approval"
          ? [entry.approval.request.sessionKey, entry.approval.sourceSessionKey]
          : entry.type === "mention"
            ? [entry.mention.sessionKey]
            : [];
    return entry.requiresAction && !keys.some((key) => isIncognitoSessionKey(key));
  }).length;
}

function containsIncognito(rows: readonly SidebarRecentSession[]): boolean {
  return rows.some(
    (row) => row.incognito || isIncognitoSessionKey(row.key) || containsIncognito(row.children),
  );
}

function snapshotAttention(value: SidebarSessionAttention, preserveNone = false) {
  return value.kind === "agent"
    ? value.icon
    : value.kind === "none" && !preserveNone
      ? undefined
      : value.kind;
}
function restoreAttention(
  value: NonNullable<SidebarSnapshotSession["state"]>["attention"],
  key: string,
): SidebarSessionAttention {
  if (!value || value === "none") {
    return { kind: "none" };
  }
  if (value === "error") {
    return { kind: "error", reason: "", sourceSessionKey: key };
  }
  if (value === "question" || value === "approval") {
    return { kind: value, requests: [] };
  }
  return { kind: "agent", icon: value, note: "", sourceSessionKey: key };
}
function snapshotChildren(value: SidebarRecentSession["subagentSummary"]) {
  if (!value) {
    return undefined;
  }
  const state = {
    attention: snapshotAttention(value.attention),
    runningChildCount: value.runningChildCount || undefined,
    queuedChildCount: value.queuedChildCount || undefined,
    unreadChildCount: value.unreadChildCount || undefined,
  };
  return Object.values(state).some((item) => item !== undefined) ? state : undefined;
}

export function snapshotSessions(
  rows: readonly SidebarRecentSession[],
  presentation?: (
    row: SidebarRecentSession,
  ) => Pick<
    SidebarSnapshotSession,
    "snapshotSubtitle" | "childrenDisplayMode" | "state" | "owner" | "archivedBy" | "participants"
  >,
): SidebarSnapshotSession[] {
  return rows
    .filter((row) => !row.incognito && !isIncognitoSessionKey(row.key))
    .map((row) => {
      const privateChildren = containsIncognito([
        ...row.children,
        ...(row.unreadHiddenRuns ?? []),
        ...(row.subagentSummary?.unreadHiddenRuns ?? []),
      ]);
      const display = presentation?.(row);
      const state = {
        pinnable: row.snapshot ? row.snapshot.pinnable : row.pinnable ? undefined : false,
        childCount: privateChildren
          ? undefined
          : row.snapshot
            ? row.snapshot.childCount
            : row.childSessionKeys.filter((key) => !isIncognitoSessionKey(key)).length || undefined,
        ...snapshotChildren(privateChildren ? undefined : row),
        unread: row.unread || undefined,
        isRunVisuallyActive: (row.isRunVisuallyActive ?? row.hasActiveRun) || undefined,
        hasAutomation: row.hasAutomation || undefined,
        status: row.isChild || row.status !== "done" ? row.status : undefined,
        workSession: row.workSession || undefined,
        acpSession: row.acpSession || undefined,
        workspaceKind: row.workspaceKind,
        attention: snapshotAttention(
          privateChildren ? (row.ownAttention ?? { kind: "none" }) : row.attention,
        ),
        ownAttention:
          row.attention.kind !== "none" && row.ownAttention
            ? snapshotAttention(row.ownAttention, true)
            : undefined,
        subagentSummary: !privateChildren ? snapshotChildren(row.subagentSummary) : undefined,
        ...(!privateChildren ? display?.state : undefined),
      };
      return {
        key: row.key,
        label: row.label,
        agentId: row.agentId,
        owner: display?.owner ?? row.owner,
        archivedBy: display?.archivedBy ?? row.archivedBy,
        participants: display?.participants ?? row.participants,
        participantCount: row.participantCount,
        subtitle: row.subtitle,
        icon: row.icon,
        color: row.color,
        pinned: row.pinned,
        isChild: row.isChild,
        category: row.category,
        archived: row.archived,
        boardFace: row.boardFace,
        state: Object.values(state).some((value) => value !== undefined) ? state : undefined,
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

export function restoreSnapshotSession(
  row: SidebarSnapshotSession,
  selected: string,
): SidebarRecentSession {
  const state = row.state;
  return {
    ...row,
    ...state,
    snapshot: state ?? {},
    renameValue: row.label,
    active: row.key === selected,
    visuallyActive: row.key === selected,
    hasActiveRun: false,
    modelSelectionLocked: true,
    pinnable: false,
    cloudWorkerStopAction: null,
    hasAutomation: state?.hasAutomation ?? false,
    unread: state?.unread ?? false,
    attention: restoreAttention(
      state?.attention === "error" ? (state.ownAttention ?? state.attention) : state?.attention,
      row.key,
    ),
    ownAttention: state?.ownAttention && restoreAttention(state.ownAttention, row.key),
    subagentSummary: state?.subagentSummary && {
      ...state.subagentSummary,
      attention: restoreAttention(
        state.subagentSummary.attention === "error" ? "none" : state.subagentSummary.attention,
        row.key,
      ),
      runningChildCount: state.subagentSummary.runningChildCount ?? 0,
    },
    childSessionKeys: row.children.map((child) => child.key),
    childLoadParentKeys: row.childLoadParentKeys ?? [],
    children: row.children.map((child) => restoreSnapshotSession(child, selected)),
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: state?.runningChildCount ?? 0,
  };
}

export function restoreSnapshotNavigation(model: SidebarSnapshotModel, selectedKey: string) {
  const sections = model.sections.map((section) => ({
    ...section,
    rows: section.rows.map((row) => restoreSnapshotSession(row, selectedKey)),
  }));
  const visibleRows = sections.flatMap((section) => section.rows);
  const pins = model.pinnedSessions.map((row) => restoreSnapshotSession(row, selectedKey));
  const presence = model.onlineUsers.map((user) => ({
    ts: 0,
    user,
    watchedSessions: user.watchedSessions,
  }));
  return {
    sections,
    visibleRows,
    home: model.home && restoreSnapshotSession(model.home, selectedKey),
    presence: { presence },
    zone: {
      entries: model.entries.flatMap((entry) => parseSidebarEntry(entry) ?? []),
      sidebarEntries: model.entries,
      sessionRows: new Map([...visibleRows, ...pins].map((row) => [row.key, row])),
      pluginTabs: new Map(model.plugins.map(({ key, ...tab }) => [key, tab])),
    },
  };
}

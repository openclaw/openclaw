import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { sidebarInboxTabCounts, type SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import type { SidebarSnapshotModel, SidebarSnapshotSession } from "./sidebar-snapshot-data.ts";

export {
  parseSidebarSnapshot,
  type SidebarSnapshotModel,
  type SidebarSnapshotSession,
} from "./sidebar-snapshot-data.ts";

export function snapshotIssuesCount(entries: readonly SidebarInboxEntry[]): number {
  return sidebarInboxTabCounts(
    entries.filter((entry) => {
      const keys =
        entry.type === "outbox"
          ? [entry.sessionKey]
          : entry.type === "approval"
            ? [entry.approval.request.sessionKey, entry.approval.sourceSessionKey]
            : entry.type === "mention"
              ? [entry.mention.sessionKey]
              : [];
      return !keys.some((key) => isIncognitoSessionKey(key));
    }),
  ).all;
}

function containsIncognito(rows: readonly SidebarRecentSession[]): boolean {
  return rows.some(
    (row) => row.incognito || isIncognitoSessionKey(row.key) || containsIncognito(row.children),
  );
}

function snapshotAttention(value: SidebarSessionAttention, preserveNone = false) {
  return value.kind === "none" && !preserveNone
    ? undefined
    : {
        kind: value.kind,
        icon: value.kind === "agent" ? value.icon : undefined,
      };
}

function restoreAttention(
  value: NonNullable<SidebarSnapshotSession["state"]>["attention"],
  key: string,
): SidebarSessionAttention {
  if (!value || value.kind === "none") return { kind: "none" };
  if (value.kind === "agent")
    return { kind: "agent", icon: value.icon!, note: "", sourceSessionKey: key };
  if (value.kind === "error") return { kind: "error", reason: "", sourceSessionKey: key };
  return { kind: value.kind, requests: [] };
}

export function snapshotSessions(
  rows: readonly SidebarRecentSession[],
  presentation?: (
    row: SidebarRecentSession,
  ) => Pick<SidebarSnapshotSession, "snapshotSubtitle" | "childrenDisplayMode" | "state">,
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
        state: {
          unread: row.unread || undefined,
          isRunVisuallyActive: (row.isRunVisuallyActive ?? row.hasActiveRun) || undefined,
          hasAutomation: row.hasAutomation || undefined,
          status: row.status,
          workSession: row.workSession || undefined,
          acpSession: row.acpSession || undefined,
          workspaceKind: row.workspaceKind,
          attention: snapshotAttention(
            privateChildren ? (row.ownAttention ?? { kind: "none" }) : row.attention,
          ),
          ownAttention: row.ownAttention && snapshotAttention(row.ownAttention, true),
          runningChildCount: privateChildren ? undefined : row.runningChildCount || undefined,
          queuedChildCount: privateChildren ? undefined : row.queuedChildCount || undefined,
          unreadChildCount: privateChildren ? undefined : row.unreadChildCount || undefined,
          failedChildCount: privateChildren ? undefined : row.failedChildCount || undefined,
          subagentSummary:
            !privateChildren && row.subagentSummary
              ? {
                  attention: snapshotAttention(row.subagentSummary.attention),
                  runningChildCount: row.subagentSummary.runningChildCount || undefined,
                  queuedChildCount: row.subagentSummary.queuedChildCount || undefined,
                  unreadChildCount: row.subagentSummary.unreadChildCount || undefined,
                  failedChildCount: row.subagentSummary.failedChildCount || undefined,
                }
              : undefined,
          ...(!privateChildren ? display?.state : undefined),
        },
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
    ...row.state,
    snapshot: row.state ?? {},
    renameValue: row.label,
    active: row.key === selected,
    visuallyActive: row.key === selected,
    hasActiveRun: false,
    modelSelectionLocked: true,
    pinnable: false,
    cloudWorkerStopAction: null,
    hasAutomation: row.state?.hasAutomation ?? false,
    unread: row.state?.unread ?? false,
    attention: restoreAttention(row.state?.attention, row.key),
    ownAttention: row.state?.ownAttention && restoreAttention(row.state.ownAttention, row.key),
    subagentSummary: row.state?.subagentSummary && {
      ...row.state.subagentSummary,
      attention: restoreAttention(row.state.subagentSummary.attention, row.key),
      runningChildCount: row.state.subagentSummary.runningChildCount ?? 0,
      failedChildCount: row.state.subagentSummary.failedChildCount ?? 0,
    },
    childSessionKeys: row.children.map((child) => child.key),
    childLoadParentKeys: row.childLoadParentKeys ?? [],
    children: row.children.map((child) => restoreSnapshotSession(child, selected)),
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: row.state?.runningChildCount ?? 0,
    failedChildCount: row.state?.failedChildCount ?? 0,
  };
}

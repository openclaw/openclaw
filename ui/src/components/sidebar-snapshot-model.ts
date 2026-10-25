import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { resolveSessionDisplayName, resolveSessionWorkSubtitle } from "../lib/session-display.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SidebarSnapshotModel, SidebarSnapshotSession } from "./sidebar-snapshot-data.ts";

export {
  parseSidebarSnapshot,
  type SidebarSnapshotModel,
  type SidebarSnapshotSession,
} from "./sidebar-snapshot-data.ts";

type SnapshotDisplay = Partial<SidebarSnapshotSession>;

function containsIncognito(rows: readonly SidebarRecentSession[]): boolean {
  return rows.some(
    (row) => row.incognito || isIncognitoSessionKey(row.key) || containsIncognito(row.children),
  );
}
/** Saved placements share visible facts; stable headers remain in the boot roster. */
export function createSidebarSnapshotRows(
  presentation?: (row: SidebarRecentSession) => SnapshotDisplay,
  roster?: SidebarSnapshotModel["roster"],
) {
  const rows: SidebarSnapshotModel["rows"] = {};
  const capture = (source: readonly SidebarRecentSession[]): string[] =>
    source
      .filter((row) => !row.incognito && !isIncognitoSessionKey(row.key))
      .map((row) => {
        if (rows[row.key]) {
          return row.key;
        }
        const privateChildren = containsIncognito([
          ...row.children,
          ...(row.unreadHiddenRuns ?? []),
          ...(row.subagentSummary?.unreadHiddenRuns ?? []),
        ]);
        const display = presentation?.(
          privateChildren
            ? {
                ...row,
                attention: row.ownAttention ?? { kind: "none" },
                runningChildCount: 0,
                failedChildCount: 0,
                unreadChildCount: 0,
                queuedChildCount: 0,
                subagentSummary: undefined,
              }
            : row,
        );
        const header = roster?.result.sessions.find((entry) => entry.key === row.key);
        rows[row.key] = {
          ...(header
            ? {}
            : {
                agentId: row.agentId,
                worktreeId: row.worktreeId,
                subtitle: row.subtitle,
                icon: row.icon,
                color: row.color,
                category: row.category,
                archived: row.archived,
                boardFace: row.boardFace,
              }),
          label:
            header &&
            resolveSessionDisplayName(row.key, { ...header, accountId: undefined }) === row.label
              ? undefined
              : row.label,
          pinned: row.pinned === Boolean(header?.pinned) ? undefined : row.pinned,
          isChild: row.isChild || undefined,
          unread: row.unread || undefined,
          status: row.isChild ? row.status : undefined,
          hasAutomation: row.hasAutomation || undefined,
          ...display,
          participants:
            display?.participants ??
            ((row.participantCount ?? row.participants?.length) === 1
              ? row.participants?.slice(0, 1)
              : undefined),
          participantCount: row.participantCount,
          childLoadParentKeys: row.childLoadParentKeys?.filter(
            (key) => !isIncognitoSessionKey(key),
          ),
          snapshotSubtitle: privateChildren ? undefined : display?.snapshotSubtitle,
          children: [],
        };
        rows[row.key]!.children = capture(row.children);
        return row.key;
      });
  return { rows, capture };
}

export function snapshotSections(
  source: SidebarVisibleSections["sections"],
  collapsedSections: ReadonlySet<string>,
  capture: ReturnType<typeof createSidebarSnapshotRows>["capture"],
) {
  const sections = source.flatMap((section) => {
    const rows = capture(section.rows);
    return section.rows.length > 0 && rows.length === 0
      ? []
      : [
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
    collapsedSections: [...collapsedSections].filter(
      (id) => id === "pinned" || id === "online" || retained.has(id),
    ),
  };
}

export function restoreSnapshotSections(
  model: SidebarSnapshotModel,
  selected: string,
): SidebarVisibleSections {
  const sections = model.sections.map((section) => ({
    ...section,
    rows: section.rows.map((key) => restoreSnapshotSession(model, key, selected)),
  }));
  return { sections, visibleRows: sections.flatMap((section) => section.rows) };
}

export function restoreSnapshotSession(
  model: SidebarSnapshotModel,
  key: string,
  selected: string,
): SidebarRecentSession {
  const row = model.rows[key]!;
  const header = model.roster?.result.sessions.find((entry) => entry.key === key);
  const label = row.label ?? resolveSessionDisplayName(key, header);
  return {
    ...header,
    ...row,
    key,
    label,
    renameValue: label,
    agentId:
      row.agentId ??
      resolveUiSessionRowAgentId({ key, agentId: header?.agentId }, model.brand.agentId ?? "main"),
    worktreeId: row.worktreeId ?? header?.worktree?.id,
    subtitle: row.subtitle ?? (header ? resolveSessionWorkSubtitle(header) : undefined),
    pinned: row.pinned ?? header?.pinned ?? false,
    isChild: row.isChild ?? false,
    active: key === selected,
    visuallyActive: key === selected,
    hasActiveRun: false,
    modelSelectionLocked: true,
    pinnable: false,
    cloudWorkerStopAction: null,
    owner: undefined,
    hasAutomation: row.hasAutomation ?? false,
    unread: row.unread ?? false,
    attention: { kind: "none" },
    ownAttention: undefined,
    snapshot: row,
    childSessionKeys: row.children,
    childLoadParentKeys: row.childLoadParentKeys ?? [],
    children: row.children.map((child) => restoreSnapshotSession(model, child, selected)),
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
  };
}

export function sidebarSnapshotAvatarUrls(model: SidebarSnapshotModel): string[] {
  return [
    model.brand.avatar,
    model.footer?.avatarUrl,
    ...model.cards.map((card) => card.avatar),
    ...(model.avatarAgents ?? []).map((agent) => agent.avatar),
    ...[...model.onlineUsers, ...model.offlineUsers, ...(model.ownerOptions ?? [])].map(
      (user) => user.avatarUrl,
    ),
    ...Object.values(model.rows).flatMap((row) => [
      row.owner?.avatarUrl,
      ...(row.viewers ?? []).map((user) => user.avatarUrl),
      ...(row.participants ?? []).map((person) => person.avatarUrl),
    ]),
  ].filter((url): url is string => Boolean(url));
}

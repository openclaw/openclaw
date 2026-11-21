import type { GatewaySessionRow } from "../api/types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { registerSessionMenuEnglish } from "../i18n/locales/en-session-menu.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../lib/format-error.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { sessionAccessRowForBatch } from "../lib/session-method-access.ts";
import { fetchChildSessionRows } from "../lib/sessions/child-session-data.ts";
import { customSnoozeStorageKey, rememberCustomSnooze } from "../lib/sessions/custom-snooze.ts";
import { fetchPagedSessionRows } from "../lib/sessions/paged-session-rows.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
  resolveUiSessionRowAgentId,
  isSubagentSessionKey,
} from "../lib/sessions/session-key.ts";
import { requestSessionListParams } from "../lib/sessions/session-requests.ts";
import { formatSessionSnoozeWakeTime } from "../lib/sessions/session-snooze.ts";
import { showToast } from "../lib/toast.ts";
import { startSidebarArchiveExit } from "./app-sidebar-archive-exit.ts";
import type { SidebarSessionMutationScope } from "./app-sidebar-session-types.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "./confirm-dialog.ts";
import { holdArchive } from "./session-archive-hold.ts";
import {
  confirmWithBoundAutomations,
  withBoundAutomationNotice,
} from "./session-automation-confirm.ts";
import { isSessionMutationScopeCurrent } from "./session-mutation-scope.ts";
import {
  patchSessionRows,
  requireSessionMutationAccess,
  type SessionActionHost,
  type SessionActionRow,
} from "./session-organizer-batch-mutations.ts";
import { patchSession } from "./session-organizer-patch.runtime.ts";

registerSessionMenuEnglish();
registerSessionOrganizationEnglish();

export async function snoozeSessionWithUndo(
  host: SessionActionHost,
  session: SessionActionRow,
  choice: { snoozedUntil: number; rememberCustom?: boolean },
  scope: SidebarSessionMutationScope,
) {
  const { snoozedUntil, rememberCustom } = choice;
  const result = await patchSession(host, session, { snoozedUntil }, scope, { sessionScope: true });
  if (result !== "completed" || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (rememberCustom) {
    rememberCustomSnooze(
      customSnoozeStorageKey(scope.client.gatewayUrl, scope.client.recoveryScope),
      snoozedUntil,
    );
  }
  const undoHost = sessionUndoHost(host, scope);
  showToast({
    severity: "success",
    message: t("sessionsView.sessionSnoozed", { time: formatSessionSnoozeWakeTime(snoozedUntil) }),
    actionLabel: t("common.undo"),
    onAction: () =>
      void patchSession(undoHost, session, { snoozedUntil: null }, scope, { sessionScope: true }),
  });
}

export async function promoteSession(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  const result = await patchSession(host, session, { sidebarRoot: true }, scope, {
    sessionScope: true,
  });
  if (result === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ severity: "success", message: t("sessionsView.sessionMovedToTopLevel") });
  }
}

type ArchiveTreeRow = {
  row: GatewaySessionRow;
  ancestors: readonly GatewaySessionRow[];
};

/** Snapshot the same sidebar ancestry for a single session or a whole group. */
async function collectArchiveTree(
  roots: readonly GatewaySessionRow[],
  scope: SidebarSessionMutationScope,
  isCurrent: () => boolean,
): Promise<ArchiveTreeRow[] | null> {
  const rows: ArchiveTreeRow[] = [];
  const visited = new Set<string>();
  const pending: ArchiveTreeRow[] = roots.map((row) => ({ row, ancestors: [] }));
  for (const entry of pending) {
    const { row, ancestors } = entry;
    if (visited.has(row.key)) {
      continue;
    }
    const persistent = !isSubagentSessionKey(row.key);
    if (
      row.archived ||
      (persistent && ancestors.length > 0 && (row.sidebarRoot || row.category?.trim()))
    ) {
      continue;
    }
    visited.add(row.key);
    if (persistent) {
      rows.push(entry);
    }
    // Fresh Gateway rows already carry the visible child keys. A leaf needs no list read.
    if (!row.childSessions?.length) {
      continue;
    }
    const children = await fetchChildSessionRows({
      sessions: scope.sessions,
      parentKey: row.key,
      isCurrent,
    });
    if (!children || !isCurrent()) {
      return null;
    }
    const nextAncestors = persistent ? [row, ...ancestors] : ancestors;
    // Child lists include control relationships; archive follows sidebar navigation ancestry.
    for (const child of children) {
      if (
        areUiSessionKeysEquivalent(resolveUiSessionNavigationParentKey(child) ?? row.key, row.key)
      ) {
        pending.push({ row: child, ancestors: nextAncestors });
      }
    }
  }
  if (!isCurrent()) {
    return null;
  }
  if (rows.some(({ row }) => !row.sessionId)) {
    throw new Error(t("sessionsView.archiveTreeChanged"));
  }
  return rows;
}

function archiveTreeTargets(
  tree: readonly ArchiveTreeRow[],
  scope: SidebarSessionMutationScope,
): SessionActionRow[] {
  // Descendants settle before their ancestors, including across batch boundaries.
  return tree.toReversed().map(({ row, ancestors }) => ({
    key: row.key,
    agentId: row.agentId,
    sessionId: row.sessionId,
    sharingRole: row.sharingRole,
    label: resolveSessionDisplayName(row.key, row),
    pinned: row.pinned === true,
    archived: row.archived,
    category: row.category,
    active: hasActiveArchiveWork(row),
    hasAutomation: row.hasAutomation,
    archiveGuard: {
      expectedSidebarRoot: row.sidebarRoot === true,
      expectedCategory: row.category ?? null,
      expectedArchived: false,
      ...(ancestors.length > 0
        ? {
            expectedSidebarAncestors: ancestors.map((ancestor) => ({
              key: ancestor.key,
              agentId: resolveUiSessionRowAgentId(ancestor, scope.selectedAgentId),
              expectedSessionId: ancestor.sessionId!,
              expectedSidebarRoot: ancestor.sidebarRoot === true,
              expectedCategory: ancestor.category ?? null,
            })),
          }
        : {}),
    },
  }));
}

export async function archiveSessionGroupWithUndo(
  host: SessionActionHost,
  group: string,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  const isCurrent = () => host.sessionData.isSessionMutationScopeCurrent(scope);
  if (!isCurrent()) {
    return;
  }
  const listError = t("sessionsView.archiveGroupListFailed");
  // Use Gateway group membership, not the visible sidebar window or its filters.
  const roots = await fetchPagedSessionRows({
    list: (offset) =>
      requestSessionListParams(
        scope.client,
        { source: "sidebar", group, archived: false, excludeSubagents: true, limit: 100, offset },
        isCurrent,
        { signal: scope.signal },
      ),
    isCurrent,
    missingResultError: listError,
    stalledPaginationError: listError,
    incompletePaginationError: listError,
  });
  if (!roots) {
    return;
  }
  const tree = await collectArchiveTree(
    roots.filter((row) => row.category === group),
    scope,
    isCurrent,
  );
  if (!tree) {
    return;
  }
  const rows = archiveTreeTargets(tree, scope).filter(
    (row) => !scope.sessions.archiveVisibility(row.key),
  );
  if (rows.length === 0) {
    showToast({ severity: "info", message: t("sessionsView.archiveGroupEmpty") });
    return;
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.patchMany",
      params: { patch: { archived: true } },
      sessionScope: true,
      session: sessionAccessRowForBatch(rows),
    })
  ) {
    return;
  }
  const count = String(rows.length);
  const confirmLabel = t("sessionsView.archiveAllSessions", { count });
  const options = {
    title: t("sessionsView.archiveGroupPrompt"),
    message:
      (rows.length === 1
        ? t("sessionsView.archiveGroupSessionOne")
        : t("sessionsView.archiveGroupSessionOther", { count })) +
      (rows.some((row) => row.active) ? "\n\n" + t("sessionsView.archiveRunningSessions") : ""),
    confirmLabel,
    signal: scope.signal,
  };
  const confirmed = await confirmWithBoundAutomations(
    archiveAutomationRequest(rows, scope),
    (notice) =>
      showConfirmDialog(
        notice ? { ...withBoundAutomationNotice(options, notice), confirmLabel } : options,
      ),
    Boolean,
  );
  if (confirmed) {
    archiveConfirmedSessionsWithUndo(host, rows, scope);
  }
}

/** Discover descendants only for hinted parents; leaf archives keep their existing fast path. */
export async function confirmSessionArchive(
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
  isCurrent: () => boolean,
): Promise<{ kind: "single" } | { kind: "tree"; rows: SessionActionRow[] } | null> {
  if (!isCurrent()) {
    return null;
  }
  if (session.hasArchiveDescendants && scope.gateway.snapshot.phase !== "connected") {
    // Complete subtree discovery requires live reads. Offline intent targets
    // only the selected row, with the same explicit nested-session warning.
    const options = {
      title: t("sessionsView.archiveSessionTitle"),
      message:
        t("sessionsView.archiveSessionNestedOffline", { session: session.label }) +
        (hasActiveArchiveWork(session) ? "\n\n" + t("sessionsView.archiveRunningSessions") : ""),
      confirmLabel: t("sessionsView.archiveThisSession"),
      signal: scope.signal,
    };
    const confirmed = await confirmWithBoundAutomations(
      archiveAutomationRequest([session], scope),
      (notice) => showConfirmDialog(notice ? withBoundAutomationNotice(options, notice) : options),
      Boolean,
    );
    return confirmed && isCurrent() ? { kind: "single" } : null;
  }
  if (session.hasArchiveDescendants) {
    const { session: root } = await scope.sessions.describe(
      {
        key: session.key,
        agentId: resolveUiSessionRowAgentId(session, scope.selectedAgentId),
      },
      { refresh: true },
    );
    if (!isCurrent()) {
      return null;
    }
    if (!root || !root.sessionId || root.sessionId !== session.sessionId || root.archived) {
      throw new Error(t("sessionsView.archiveTreeChanged"));
    }
    if (isSubagentSessionKey(root.key)) {
      throw new Error(t("sessionsView.archiveTreeRootRequired"));
    }
    const tree = await collectArchiveTree([root], scope, isCurrent);
    if (!tree) {
      return null;
    }
    if (tree.length > 1) {
      const guardedRows = archiveTreeTargets(tree, scope);
      // Only direct children move to the top level; deeper sessions stay under them.
      const directChildCount = tree.filter(({ ancestors }) => ancestors.length === 1).length;
      const options = {
        title: t("sessionsView.archiveSessionTitle"),
        message:
          t(
            directChildCount === 1
              ? "sessionsView.archiveSessionNestedOne"
              : "sessionsView.archiveSessionNestedOther",
            { count: String(directChildCount), session: session.label },
          ) +
          (guardedRows.some((row) => row.active)
            ? "\n\n" + t("sessionsView.archiveRunningSessions")
            : ""),
        confirmLabel: t("sessionsView.archiveAllSessions", { count: String(guardedRows.length) }),
        alternativeLabel: t("sessionsView.archiveThisSession"),
        groupChoicesOnMobile: true,
        signal: scope.signal,
      };
      // The tree choice keeps its own labels; only bound conversations that end up archived pause.
      const choice = await confirmWithBoundAutomations(
        archiveAutomationRequest(guardedRows, scope),
        (notice) =>
          showConfirmChoiceDialog(
            notice
              ? {
                  ...withBoundAutomationNotice(options, notice),
                  confirmLabel: options.confirmLabel,
                }
              : options,
          ),
        (result) => result !== null,
      );
      if (!isCurrent() || choice === null) {
        return null;
      }
      return choice === "confirm" ? { kind: "tree", rows: guardedRows } : { kind: "single" };
    }
  }
  return (await confirmRunningSessionsArchive([session], scope)) && isCurrent()
    ? { kind: "single" }
    : null;
}

type SessionArchiveActivity = Pick<
  SessionActionRow,
  "hasActiveRun" | "gatewayHasActiveRun" | "hasActiveSubagentRun"
>;

function hasActiveArchiveWork(session: SessionArchiveActivity): boolean {
  return Boolean(
    (session.gatewayHasActiveRun ?? session.hasActiveRun) || session.hasActiveSubagentRun,
  );
}

type SessionArchiveConfirmScope = Pick<
  SidebarSessionMutationScope,
  "gateway" | "selectedAgentId" | "signal"
>;

function archiveAutomationRequest(
  sessions: readonly Pick<SessionActionRow, "key" | "agentId" | "label" | "hasAutomation">[],
  scope: SessionArchiveConfirmScope,
) {
  return {
    action: "archive" as const,
    sessions,
    gateway: scope.gateway,
    selectedAgentId: scope.selectedAgentId,
    signal: scope.signal,
  };
}

export async function confirmRunningSessionsArchive(
  sessions: readonly (SessionArchiveActivity &
    Pick<SessionActionRow, "key" | "agentId" | "label" | "hasAutomation">)[],
  scope: SessionArchiveConfirmScope,
): Promise<boolean> {
  const running = sessions.some(hasActiveArchiveWork);
  const single = sessions.length === 1 ? sessions[0] : undefined;
  const options = {
    title: single
      ? t("sessionsView.archiveSessionPrompt", { session: single.label })
      : t("sessionsView.archiveSessionsPrompt", { count: String(sessions.length) }),
    message: !running
      ? ""
      : single
        ? t("sessionsView.archiveRunningSessionConfirm")
        : t("sessionsView.archiveRunningSessions"),
    confirmLabel: single
      ? t("sessionsView.archiveSession")
      : t("sessionsView.archiveSessionCount", { count: String(sessions.length) }),
    signal: scope.signal,
  };
  // Leaf and batch archives confirm only for active work or bound automations.
  return confirmWithBoundAutomations(
    archiveAutomationRequest(sessions, scope),
    (notice) =>
      notice
        ? showConfirmDialog(withBoundAutomationNotice(options, notice))
        : running
          ? showConfirmDialog(options)
          : Promise.resolve(true),
    Boolean,
  );
}

export async function archiveSessionWithUndo(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
  exitFrom?: HTMLElement,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  let choice: Awaited<ReturnType<typeof confirmSessionArchive>>;
  try {
    choice = await confirmSessionArchive(session, scope, () =>
      host.sessionData.isSessionMutationScopeCurrent(scope),
    );
  } catch (error) {
    if (host.sessionData.isSessionMutationScopeCurrent(scope)) {
      host.sessionData.publishSessionMutationError(scope, error);
    }
    return;
  }
  if (!choice) {
    return;
  }
  archiveConfirmedSessionsWithUndo(
    host,
    choice.kind === "tree" ? choice.rows : [session],
    scope,
    choice.kind === "tree" ? undefined : exitFrom,
  );
}

export async function archiveSessionsWithUndo(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (await confirmRunningSessionsArchive(rows, scope)) {
    archiveConfirmedSessionsWithUndo(host, rows, scope);
  }
}

/** Hides confirmed rows now and archives them when their Undo window closes. */
export function archiveConfirmedSessionsWithUndo(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  scope: SidebarSessionMutationScope,
  exitFrom?: HTMLElement,
): "completed" | void {
  if (rows.length === 0 || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  // The commit outlives the initiating pane; online work stays connection-scoped and
  // offline work follows its recovery owner.
  const outcomeHost = sessionUndoHost(host, scope);
  const stopExit = exitFrom ? startSidebarArchiveExit(exitFrom) : undefined;
  const pending = rows.flatMap((row) => {
    const finish = scope.sessions.beginArchive(row.key, row.sessionId);
    return finish ? [{ row, finish }] : [];
  });
  stopExit?.();
  if (pending.length === 0) {
    return;
  }
  const accepted = pending.map(({ row }) => row);
  const single = accepted.length === 1 && !accepted[0]!.archiveGuard ? accepted[0] : undefined;
  holdArchiveForUndo({
    keys: accepted.map((row) => row.key),
    commit: () =>
      single
        ? patchSession(outcomeHost, single, { archived: true }, scope, { sessionScope: true })
        : patchSessionRows(outcomeHost, accepted, { archived: true }, scope, {
            sessionScope: true,
          }),
    publishError: (error) => outcomeHost.sessionData.publishSessionMutationError(scope, error),
    release: () => {
      for (const { finish } of pending) {
        finish();
      }
    },
  });
  return "completed";
}

/**
 * Archive is a deferred commit. The rows are already hidden; the toast holds the
 * request until its Undo window closes, so Undo only releases local state and the
 * rows return instantly. Every other toast ending (timeout, close, replacement)
 * commits, and so does leaving the page. Accepted edge: a reconnect inside the
 * window, or a page close that loses the final request, leaves the session
 * unarchived and it simply reappears.
 */
function holdArchiveForUndo(archive: {
  keys: readonly string[];
  commit: () => Promise<unknown>;
  publishError: (error: unknown) => void;
  release: () => void;
}) {
  let settled = false;
  const toast = new AbortController();
  const held = {
    keys: archive.keys,
    settle: (commit: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      unhold();
      if (!commit) {
        // Undo can come from the session's own banner; retire the notice too.
        toast.abort();
        archive.release();
        return;
      }
      // Keep the rows hidden until the archive confirms or fails.
      void archive.commit().catch(archive.publishError).finally(archive.release);
    },
  };
  const unhold = holdArchive(held);
  showToast({
    severity: "success",
    message:
      archive.keys.length === 1
        ? t("sessionsView.sessionArchived")
        : t("sessionsView.sessionsArchived", { count: String(archive.keys.length) }),
    actionLabel: t("common.undo"),
    signal: toast.signal,
    onAction: () => held.settle(false),
    onDismiss: (reason) => {
      if (reason !== "action") {
        held.settle(true);
      }
    },
  });
}

function captureSessionUndoCurrent(scope: SidebarSessionMutationScope): () => boolean {
  const connection = scope.sessions.captureConnectionScope();
  if (connection) {
    return () => scope.sessions.isConnectionScopeCurrent(connection);
  }
  // Offline Undo follows the admitted recovery owner across reconnect, not the pane's
  // retired confirmation epoch. The session owner still authorizes each write.
  const owner = gatewayPresentationScope(scope.gateway).key;
  return () =>
    scope.allowDeferred === true &&
    isSessionMutationScopeCurrent(scope.context, scope) &&
    gatewayPresentationScope(scope.gateway).key === owner;
}

function sessionUndoHost(
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
): SessionActionHost {
  // The toast outlives its originating pane; captured row IDs still fence
  // replacement conversations when its write runs.
  const isCurrent = captureSessionUndoCurrent(scope);
  return {
    pruneSidebarSessionEntry: (key) => host.pruneSidebarSessionEntry(key),
    selectSession: (key) => host.selectSession(key),
    sidebarSessionStatusFilter: () => host.sidebarSessionStatusFilter(),
    sessionData: {
      refreshSidebarSessions: (agentId) => host.sessionData.refreshSidebarSessions(agentId),
      isSessionMutationScopeCurrent: isCurrent,
      publishSessionMutationError: (candidate, error) => {
        if (host.sessionData.isSessionMutationScopeCurrent(candidate)) {
          host.sessionData.publishSessionMutationError(candidate, error);
        } else if (isCurrent()) {
          showToast({ severity: "error", message: formatUiError(error) });
        }
      },
    },
  };
}

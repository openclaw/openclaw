import { t } from "../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../lib/format-error.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { fetchChildSessionRows } from "../lib/sessions/child-session-data.ts";
import { customSnoozeStorageKey, rememberCustomSnooze } from "../lib/sessions/custom-snooze.ts";
import { collectSessionArchiveTree } from "../lib/sessions/session-archive-tree.ts";
import { resolveUiSessionRowAgentId, isSubagentSessionKey } from "../lib/sessions/session-key.ts";
import { formatSessionSnoozeWakeTime } from "../lib/sessions/session-snooze.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "./confirm-dialog.ts";
import {
  patchSessionRows,
  type SessionActionHost,
  type SessionActionRow,
} from "./session-organizer-batch-mutations.ts";
import { patchSession } from "./session-organizer-patch.runtime.ts";

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
    showToast({ message: t("sessionsView.sessionMovedToTopLevel") });
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
    const tree = await collectSessionArchiveTree({
      root,
      isCurrent,
      readChildren: (parentKey) =>
        fetchChildSessionRows({ sessions: scope.sessions, parentKey, isCurrent }),
    });
    if (!tree || !isCurrent()) {
      return null;
    }
    const { rows, ancestorsByKey } = tree;
    if (rows.some((row) => !row.sessionId)) {
      throw new Error(t("sessionsView.archiveTreeChanged"));
    }
    if (rows.length > 1) {
      // Descendants settle before their ancestors, which must remain unarchived.
      const guardedRows: SessionActionRow[] = rows.toReversed().map((row) => ({
        key: row.key,
        agentId: row.agentId,
        sessionId: row.sessionId,
        sharingRole: row.sharingRole,
        label: resolveSessionDisplayName(row.key, row),
        pinned: row.pinned === true,
        archived: row.archived,
        category: row.category,
        active: row.key === session.key && session.active,
        archiveGuard: {
          expectedSidebarRoot: row.sidebarRoot === true,
          expectedCategory: row.category ?? null,
          expectedArchived: false,
          expectedSidebarAncestors: (ancestorsByKey.get(row.key) ?? []).map((ancestor) => {
            if (!ancestor.sessionId) {
              throw new Error(t("sessionsView.archiveTreeChanged"));
            }
            return {
              key: ancestor.key,
              agentId: resolveUiSessionRowAgentId(ancestor, scope.selectedAgentId),
              expectedSessionId: ancestor.sessionId,
              expectedSidebarRoot: ancestor.sidebarRoot === true,
              expectedCategory: ancestor.category ?? null,
            };
          }),
        },
      }));
      // Only direct children move to the top level; deeper sessions stay under them.
      const directChildCount = rows.filter(
        (row) => ancestorsByKey.get(row.key)?.length === 1,
      ).length;
      const choice = await showConfirmChoiceDialog({
        title: t("sessionsView.archiveSessionTitle"),
        message:
          t(
            directChildCount === 1
              ? "sessionsView.archiveSessionNestedOne"
              : "sessionsView.archiveSessionNestedOther",
            { count: String(directChildCount), session: session.label },
          ) +
          (rows.some(hasActiveArchiveWork)
            ? "\n\n" + t("sessionsView.archiveRunningSessions")
            : ""),
        confirmLabel: t("sessionsView.archiveThisSession"),
        alternativeLabel: t("sessionsView.archiveSessionCount", {
          count: t("sessionsView.groupRowCount", { count: String(rows.length) }),
        }),
        signal: scope.signal,
      });
      if (!isCurrent() || choice === null) {
        return null;
      }
      return choice === "alternative" ? { kind: "tree", rows: guardedRows } : { kind: "single" };
    }
  }
  return (await confirmRunningSessionsArchive([session], scope.signal)) && isCurrent()
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

export async function confirmRunningSessionsArchive(
  sessions: readonly (SessionArchiveActivity & Pick<SessionActionRow, "label">)[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!sessions.some(hasActiveArchiveWork)) {
    return true;
  }
  const single = sessions.length === 1 ? sessions[0] : undefined;
  return showConfirmDialog({
    message: single
      ? t("sessionsView.archiveRunningSessionConfirm", { session: single.label })
      : t("sessionsView.archiveRunningSessions"),
    confirmLabel: single
      ? t("sessionsView.archiveSession")
      : t("sessionsView.archiveSessionCount", { count: String(sessions.length) }),
    signal,
  });
}

export async function archiveSessionWithUndo(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
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
  if (choice.kind === "tree") {
    await archiveConfirmedSessionsWithUndo(host, choice.rows, scope);
    return;
  }
  const finishArchive = scope.sessions.beginArchive(session.key, session.sessionId);
  if (!finishArchive) {
    return;
  }
  let result: SidebarSessionMutationResult;
  try {
    result = await patchSession(host, session, { archived: true }, scope, { sessionScope: true });
  } finally {
    finishArchive();
  }
  if (result !== "completed" || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  showToast({
    message: t("sessionsView.sessionArchived"),
    actionLabel: t("common.undo"),
    onAction: archiveUndoAction(host, [{ session, pinned: session.pinned }], scope),
  });
}

export async function archiveSessionsWithUndo(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (await confirmRunningSessionsArchive(rows, scope.signal)) {
    await archiveConfirmedSessionsWithUndo(host, rows, scope);
  }
}

export async function archiveConfirmedSessionsWithUndo(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  scope: SidebarSessionMutationScope,
): Promise<"completed" | "stale" | { status: "failed"; error: unknown } | void> {
  if (rows.length === 0 || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  // Once confirmed, finish the batch and publish its outcome across page navigation.
  // The captured connection still retires work and Undo on reconnect.
  const outcomeHost = sessionUndoHost(host, scope);
  const pending = rows.flatMap((row) => {
    const finish = scope.sessions.beginArchive(row.key, row.sessionId);
    return finish ? [{ row, finish }] : [];
  });
  if (pending.length === 0) {
    return;
  }
  const pendingRows = pending.map(({ row }) => row);
  let failure: { status: "failed"; error: unknown } | undefined;
  const initialHost: SessionActionHost = {
    ...outcomeHost,
    sessionData: {
      ...outcomeHost.sessionData,
      publishSessionMutationError: (candidate, error) => {
        failure = { status: "failed", error };
        outcomeHost.sessionData.publishSessionMutationError(candidate, error);
      },
    },
  };
  let archivedRows: SessionActionRow[] | null;
  try {
    archivedRows = await patchSessionRows(initialHost, pendingRows, { archived: true }, scope, {
      sessionScope: true,
    });
  } finally {
    for (const { finish } of pending) {
      finish();
    }
  }
  if (!archivedRows || archivedRows.length === 0) {
    return failure ?? "stale";
  }
  const archived = archivedRows.map((session) => ({ session, pinned: session.pinned }));
  showToast({
    message:
      archived.length === 1
        ? t("sessionsView.sessionArchived")
        : t("sessionsView.sessionsArchived", { count: String(archived.length) }),
    actionLabel: t("common.undo"),
    onAction: archiveUndoAction(outcomeHost, archived, scope),
    // Keep a partial-failure notice readable before presenting successful-only Undo.
    fifo: true,
  });
  return failure ?? "completed";
}

function archiveUndoAction(
  host: SessionActionHost,
  archived: readonly { session: SessionActionRow; pinned: boolean }[],
  scope: SidebarSessionMutationScope,
): () => void {
  const undoHost = sessionUndoHost(host, scope);
  return () => void restoreArchivedSessions(undoHost, archived, scope);
}

function sessionUndoHost(
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
): SessionActionHost {
  // The toast outlives its originating pane. The session owner fences reconnects;
  // the captured row IDs still fence replacement conversations during restore.
  const connection = scope.sessions.captureConnectionScope();
  return {
    pruneSidebarSessionEntry: (key) => host.pruneSidebarSessionEntry(key),
    selectSession: (key) => host.selectSession(key),
    sidebarSessionStatusFilter: () => host.sidebarSessionStatusFilter(),
    sessionData: {
      refreshSidebarSessions: (agentId) => host.sessionData.refreshSidebarSessions(agentId),
      isSessionMutationScopeCurrent: () =>
        connection !== null && scope.sessions.isConnectionScopeCurrent(connection),
      publishSessionMutationError: (candidate, error) => {
        if (host.sessionData.isSessionMutationScopeCurrent(candidate)) {
          host.sessionData.publishSessionMutationError(candidate, error);
        } else if (connection && scope.sessions.isConnectionScopeCurrent(connection)) {
          showToast({ message: formatUiError(error) });
        }
      },
    },
  };
}

// Undo restores captured rows; the roster owner refreshes whichever queries are now visible.
async function restoreArchivedSessions(
  host: SessionActionHost,
  archived: readonly { session: SessionActionRow; pinned: boolean }[],
  scope: SidebarSessionMutationScope,
) {
  const rows = archived.map((entry) => entry.session);
  if (archived.length === 1) {
    const { session, pinned } = archived[0]!;
    const restored = await patchSession(
      host,
      session,
      { archived: false, ...(pinned ? { pinned: true } : {}) },
      scope,
      { deferListRefresh: true, sessionScope: true },
    );
    if (restored === "stale") {
      return;
    }
  } else {
    const restored = await patchSessionRows(host, rows, { archived: false }, scope, {
      deferListRefresh: true,
      sessionScope: true,
    });
    if (!restored) {
      return;
    }
    const repinRows = archived.flatMap(({ session, pinned }) =>
      pinned && restored.includes(session) ? [session] : [],
    );
    if (repinRows.length > 0) {
      const repinned = await patchSessionRows(host, repinRows, { pinned: true }, scope, {
        deferListRefresh: true,
        sessionScope: true,
      });
      if (!repinned && !host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  scope.sessions.invalidate();
  try {
    const result = await scope.sessions.refreshReplacement();
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    if (!result && scope.sessions.state.error) {
      host.sessionData.publishSessionMutationError(scope, scope.sessions.state.error);
    }
  } catch (error) {
    if (host.sessionData.isSessionMutationScopeCurrent(scope)) {
      host.sessionData.publishSessionMutationError(scope, error);
    }
  }
}

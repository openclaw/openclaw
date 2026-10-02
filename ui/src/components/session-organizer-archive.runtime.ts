import { t } from "../i18n/index.ts";
import { archiveAutomationPauseNotice } from "../lib/sessions/automation-pause.ts";
import type { SessionPatchResult } from "../lib/sessions/patch.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { confirmSessionArchive } from "./session-archive-confirmation.ts";
import {
  patchSession,
  patchSessionRows,
  sessionUndoHost,
  type SessionActionHost,
  type SessionActionRow,
} from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

export async function archiveSessionWithUndo(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (
    !(await confirmSessionArchive({
      client: scope.client,
      snapshot: scope.gateway.snapshot,
      targets: [
        { ...session, agentId: resolveUiSessionRowAgentId(session, scope.selectedAgentId) },
      ],
      signal: scope.signal,
      isCurrent: () => host.sessionData.isSessionMutationScopeCurrent(scope),
    }))
  ) {
    return;
  }
  const finishArchive = scope.sessions.beginArchive(session.key, session.sessionId);
  if (!finishArchive) {
    return;
  }
  try {
    await patchSession(host, session, { archived: true }, scope, {
      sessionScope: true,
      onConfirmed: (patched) => {
        // A later roster refresh can fail without undoing the committed archive or pause.
        const notice = archiveAutomationPauseNotice([patched.automationPause]);
        showToast({
          message: [t("sessionsView.sessionArchived"), notice?.message].filter(Boolean).join(". "),
          actionLabel: t("common.undo"),
          onAction: archiveUndoAction(host, [{ session, pinned: session.pinned }], scope),
        });
      },
    });
  } finally {
    finishArchive();
  }
}

export async function archiveSessionsWithUndo(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
) {
  if (rows.length === 0 || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (
    !(await confirmSessionArchive({
      client: scope.client,
      snapshot: scope.gateway.snapshot,
      targets: rows.map((row) => ({
        ...row,
        agentId: resolveUiSessionRowAgentId(row, scope.selectedAgentId),
      })),
      signal: scope.signal,
      isCurrent: () => host.sessionData.isSessionMutationScopeCurrent(scope),
    }))
  ) {
    return;
  }
  const pending = rows.flatMap((row) => {
    const finish = scope.sessions.beginArchive(row.key, row.sessionId);
    return finish ? [{ row, finish }] : [];
  });
  if (pending.length === 0) {
    return;
  }
  const pendingRows = pending.map(({ row }) => row);
  const connection = scope.sessions.captureConnectionScope();
  const archivedRows: SessionActionRow[] = [];
  const pauses: Array<SessionPatchResult["automationPause"]> = [];
  try {
    await patchSessionRows(host, pendingRows, { archived: true }, scope, {
      sessionScope: true,
      onConfirmed: (result, chunkRows) => {
        result.outcomes.forEach((outcome, index) => {
          const row = chunkRows[index];
          if (outcome.ok && row) {
            archivedRows.push(row);
            pauses.push(outcome.automationPause);
          }
        });
      },
    });
  } finally {
    for (const { finish } of pending) {
      finish();
    }
  }
  if (
    !connection ||
    !scope.sessions.isConnectionScopeCurrent(connection) ||
    archivedRows.length === 0
  ) {
    return;
  }
  const archived = archivedRows.map((session) => ({ session, pinned: session.pinned }));
  const notice = archiveAutomationPauseNotice(pauses);
  const message =
    archived.length === 1
      ? t("sessionsView.sessionArchived")
      : t("sessionsView.sessionsArchived", { count: String(archived.length) });
  showToast({
    message: [message, notice?.message].filter(Boolean).join(". "),
    actionLabel: t("common.undo"),
    onAction: archiveUndoAction(host, archived, scope),
  });
}

function archiveUndoAction(
  host: SessionActionHost,
  archived: readonly { session: SessionActionRow; pinned: boolean }[],
  scope: SidebarSessionMutationScope,
): () => void {
  const undoHost = sessionUndoHost(host, scope);
  return () => void restoreArchivedSessions(undoHost, archived, scope);
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

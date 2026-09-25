import type { WorktreesRemoveResult } from "../../../packages/gateway-protocol/src/index.js";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { formatUiError } from "../lib/format-error.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { resolveSessionRenamePatch } from "../lib/session-rename.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import {
  formatPreservedWorktreeConfirmation,
  formatPreservedWorktreesNotice,
} from "../lib/sessions/worktree-preservation.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
  SidebarSessionPatch,
} from "./app-sidebar-session-types.ts";
import { requestCloudWorkerStop } from "./cloud-worker-stop.runtime.ts";
import { showConfirmDialog, type ConfirmDialogSkipPreference } from "./confirm-dialog.ts";
import { showInputDialog } from "./input-dialog.ts";
import type { SessionMenuAction } from "./session-menu.ts";
import {
  patchSessionRows,
  requireSessionMutationAccess,
} from "./session-organizer-batch-mutations.ts";
import type { SessionActionHost, SessionActionRow } from "./session-organizer-batch-mutations.ts";
import { rememberSessionGroup, type SessionGroupActionHost } from "./session-organizer-catalog.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import {
  formatBatchSessionRemovalError,
  withSessionWorkspaceRecovery,
} from "./session-workspace-recovery.runtime.ts";

registerNewSessionSetupEnglish();

export type { SessionActionHost, SessionActionRow } from "./session-organizer-batch-mutations.ts";
// The controller loads this module as a single namespace, so the catalog
// operations stay reachable under their original names after the split.
export {
  deleteSessionGroup,
  renameSessionGroup,
  reorderSidebarSection,
  updateSessionGroupDefaults,
} from "./session-organizer-catalog.ts";

export { setSessionInvolvement } from "./session-organizer-batch-mutations.ts";

export async function patchSession(
  host: SessionActionHost,
  session: SessionActionRow,
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
  refresh: { deferListRefresh?: boolean; sessionScope?: boolean } = {},
): Promise<SidebarSessionMutationResult> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  const agentId = resolveUiSessionRowAgentId(session, scope.selectedAgentId);
  const requestParams = {
    key: session.key,
    ...patch,
    agentId,
    ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
  };
  if (typeof patch.archived === "boolean" && !session.sessionId?.trim()) {
    host.sessionData.publishSessionMutationError(
      scope,
      "Session lifecycle action requires a durable session identity.",
    );
    return "failed";
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.patch",
      params: requestParams,
      sessionScope: refresh.sessionScope,
      session,
    })
  ) {
    return "failed";
  }
  try {
    const request = () =>
      scope.sessions.patch(session.key, patch, {
        agentId,
        ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
        ...(refresh.deferListRefresh ? { deferListRefresh: true } : {}),
      });
    const patched =
      patch.archived === true
        ? await withSessionWorkspaceRecovery({
            action: "archive",
            session: { ...session, agentId },
            scope,
            isCurrent: () => host.sessionData.isSessionMutationScopeCurrent(scope),
            request,
          })
        : await request();
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    if (!patched) {
      if (scope.sessions.state.error) {
        host.sessionData.publishSessionMutationError(scope, scope.sessions.state.error);
      }
      return "failed";
    }
    // Unpin from any surface (menu, pin button, drag) retires the session's
    // persisted zone slot; leaving it would resurrect stale synced entries.
    // Archiving implicitly unpins server-side (sessions-patch clears
    // pinnedAt), so it retires the slot too.
    if (patch.pinned === false || (patch.archived === true && session.pinned)) {
      host.pruneSidebarSessionEntry(session.key);
    }
    if (!refresh.deferListRefresh && host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(agentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
    }
    return "completed";
  } catch (error) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    host.sessionData.publishSessionMutationError(scope, error);
    return "failed";
  }
}

async function patchSessions(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  if (rows.length === 0) {
    return "completed";
  }
  const successful = await patchSessionRows(host, rows, patch, scope);
  if (!successful) {
    return host.sessionData.isSessionMutationScopeCurrent(scope) ? "failed" : "stale";
  }
  return successful.length === rows.length ? "completed" : "failed";
}

export async function archiveSessionWithUndo(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
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

async function archiveSessionsWithUndo(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
) {
  if (rows.length === 0 || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
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
  let archivedRows: SessionActionRow[] | null;
  try {
    archivedRows = await patchSessionRows(host, pendingRows, { archived: true }, scope, {
      sessionScope: true,
    });
  } finally {
    for (const { finish } of pending) {
      finish();
    }
  }
  if (!archivedRows || archivedRows.length === 0) {
    return;
  }
  const archived = archivedRows.map((session) => ({ session, pinned: session.pinned }));
  showToast({
    message:
      archived.length === 1
        ? t("sessionsView.sessionArchived")
        : t("sessionsView.sessionsArchived", { count: String(archived.length) }),
    actionLabel: t("common.undo"),
    onAction: archiveUndoAction(host, archived, scope),
  });
}

function archiveUndoAction(
  host: SessionActionHost,
  archived: readonly { session: SessionActionRow; pinned: boolean }[],
  scope: SidebarSessionMutationScope,
): () => void {
  // The toast outlives its originating pane. The session owner fences reconnects;
  // the captured row IDs still fence replacement conversations during restore.
  const connection = scope.sessions.captureConnectionScope();
  const undoHost: SessionActionHost = {
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

/**
 * Session deletes are the repeatable, per-row destructive action here, so they
 * carry an opt-out. Stopping a cloud worker and removing a preserved worktree
 * deliberately get none: the first is a rare shared-resource action and the
 * second destroys the only copy of uncommitted work.
 */
function sessionDeleteSkipPreference(
  scope: SidebarSessionMutationScope,
): ConfirmDialogSkipPreference {
  return {
    skipped: loadSettings().sessionDeleteConfirm === false,
    remember: () => {
      patchSettings({ sessionDeleteConfirm: false });
      // A mounted Settings -> Appearance rereads settings only on this
      // notification; without it its toggle keeps showing the stale value
      // while deletes already skip the prompt.
      scope.context.theme.refresh();
    },
  };
}

/** One confirm and one preserved-worktrees alert for the whole selection. */
export async function deleteSessionsBatch(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
) {
  if (rows.length === 0) {
    return;
  }
  const confirmed = await showConfirmDialog({
    message: t("sessionsView.deleteSessionsConfirm", { count: String(rows.length) }),
    confirmLabel: t("common.delete"),
    danger: true,
    skipPreference: sessionDeleteSkipPreference(scope),
    signal: scope.signal,
  });
  // A reconnect or a replaced sessions capability can land while the modal is
  // open, so the captured scope is revalidated before any delete leaves here.
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.deleteSessionsStale", { count: String(rows.length) }) });
    return;
  }
  if (!confirmed) {
    return;
  }
  const requests = rows.map((row) => ({
    key: row.key,
    agentId: resolveUiSessionRowAgentId(row, scope.selectedAgentId),
    deleteTranscript: true,
    ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
    ...(row.archived === true ? { archivedOnly: true } : {}),
  }));
  for (const params of requests) {
    if (!requireSessionMutationAccess(host, scope, { method: "sessions.delete", params })) {
      return;
    }
  }
  try {
    const result = await scope.sessions.deleteMany(requests);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      if (result.preservedWorktrees.length > 0) {
        showToast({ message: formatPreservedWorktreesNotice(result.preservedWorktrees) });
      }
      return;
    }
    if (host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(scope.selectedAgentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    if (result.preservedWorktrees.length > 0) {
      window.alert(formatPreservedWorktreesNotice(result.preservedWorktrees));
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    if (result.errors.length > 0) {
      host.sessionData.publishSessionMutationError(
        scope,
        result.errors.map(({ error }) => formatBatchSessionRemovalError(error)).join("; "),
      );
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function runBatchSessionAction(
  host: SessionOrganizerControllerHost,
  action: SessionMenuAction,
  rows: SidebarRecentSession[],
  allUnread: boolean,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  switch (action.kind) {
    case "toggle-unread":
      await patchSessions(host, rows, { unread: !allUnread }, scope);
      break;
    case "move-to-group":
      await patchSessions(
        host,
        rows.filter((row) => (row.category ?? null) !== action.category),
        { category: action.category },
        scope,
      );
      break;
    case "toggle-archived":
      if (rows.every((row) => row.archived === true)) {
        await patchSessionRows(host, rows, { archived: false }, scope, { sessionScope: true });
      } else {
        await archiveSessionsWithUndo(
          host,
          rows.filter((row) => row.archived !== true),
          scope,
        );
      }
      break;
    case "delete":
      await deleteSessionsBatch(host, rows, scope);
      break;
    default:
      break;
  }
}

export async function renameSession(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  const value = await showInputDialog({
    signal: scope.signal,
    title: t("sessionsView.renameSessionPrompt"),
    defaultValue: session.renameValue,
  });
  if (value === null) {
    return;
  }
  const patch = resolveSessionRenamePatch(value, session.renameValue, session.userLabel);
  if (patch) {
    await patchSession(host, session, patch, scope, { sessionScope: true });
  }
}

export async function assignSessionOwner(
  host: SessionActionHost,
  session: Pick<SidebarRecentSession, "key" | "agentId">,
  owner: Pick<SessionOwnerOption, "type" | "id">,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.assignOwner",
      params: { key: session.key, owner },
      requiredScope: "operator.write",
    })
  ) {
    return;
  }
  const assigned = await scope.sessions.assignOwner(session.key, owner, {
    agentId: resolveUiSessionRowAgentId(session, scope.selectedAgentId),
  });
  if (
    host.sessionData.isSessionMutationScopeCurrent(scope) &&
    !assigned &&
    scope.sessions.state.error
  ) {
    host.sessionData.publishSessionMutationError(scope, scope.sessions.state.error);
  }
}

export async function createSessionGroup(
  host: SessionOrganizerControllerHost,
  name: string,
  sessions: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  if (sessions.some((session) => !session.sessionId)) {
    host.sessionData.publishSessionMutationError(scope, t("common.refresh"));
    return "failed";
  }
  const remembered = await rememberSessionGroup(host, name, scope);
  if (remembered !== "completed") {
    return remembered;
  }
  // The Gateway checks the identities captured with the action. A bounded
  // roster can page them out or replace a key, so it cannot authorize the move.
  if (sessions.length > 0) {
    return sessions.length === 1
      ? patchSession(host, sessions[0]!, { category: name }, scope)
      : patchSessions(host, sessions, { category: name }, scope);
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  // A header-created group starts empty and needs no assignment.
  host.requestUpdate();
  return "completed";
}

export async function assignSessionCategory(
  host: SessionGroupActionHost,
  session: SessionActionRow,
  category: string | null,
  scope: SidebarSessionMutationScope,
  patch: { pinned?: boolean } = {},
  options: { resolveSession?: () => SessionActionRow | null } = {},
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const catalogChanged = Boolean(category && !host.knownSessionGroups().includes(category));
  if (category && (await rememberSessionGroup(host, category, scope)) !== "completed") {
    return;
  }
  const currentSession = options.resolveSession ? options.resolveSession() : session;
  if (!currentSession) {
    showToast({
      message: t(catalogChanged ? "sessionsView.newGroupMoveSkipped" : "common.refresh"),
    });
    return;
  }
  if ((currentSession.category ?? null) === category && patch.pinned === undefined) {
    return;
  }
  await patchSession(host, currentSession, { category, ...patch }, scope);
}

export async function forkSession(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const agentId = resolveUiSessionRowAgentId(session, scope.selectedAgentId);
  const createParams = {
    parentSessionKey: session.key,
    fork: true,
    ...((session.gatewayHasActiveRun ?? session.hasActiveRun)
      ? { forkFrom: "last-completed" as const }
      : {}),
    agentId,
  };
  if (
    !requireSessionMutationAccess(host, scope, { method: "sessions.create", params: createParams })
  ) {
    return;
  }
  try {
    const key = await scope.sessions.create(createParams);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    if (key) {
      host.selectSession(key);
    } else {
      host.sessionData.publishSessionMutationError(
        scope,
        scope.sessions.state.error ?? t("newSession.createFailed"),
      );
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function stopCloudWorker(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
) {
  const stopAction = session.cloudWorkerStopAction;
  // The Gateway revalidates placement and run state after confirmation.
  if (!stopAction || (stopAction.blocksActiveRun && session.hasActiveRun)) {
    return;
  }
  const confirmed = await showConfirmDialog({
    message: t("sessionsView.stopCloudWorkerConfirm", { session: session.label }),
    confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
    danger: true,
    signal: scope.signal,
  });
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.stopCloudWorkerStale", { session: session.label }) });
    return;
  }
  if (!confirmed) {
    return;
  }
  if (!requireSessionMutationAccess(host, scope, stopAction)) {
    return;
  }
  try {
    const agentId = resolveUiSessionRowAgentId(session, scope.selectedAgentId);
    await requestCloudWorkerStop(
      scope.client,
      {
        key: session.key,
        agentId,
      },
      scope.context.placementStartup,
    );
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    const outcome = await scope.sessions.reconcileMutation(agentId);
    if (outcome.status === "failed" && host.sessionData.isSessionMutationScopeCurrent(scope)) {
      host.sessionData.publishSessionMutationError(scope, outcome.error);
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function deleteSession(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
  // The chat header shares this operation, so the opt-out is opt-in per caller:
  // only the sidebar the setting names may offer it, and the default keeps asking.
  options: { offerSkip?: boolean } = {},
) {
  const confirmed = await showConfirmDialog({
    message: t("sessionsView.deleteSessionConfirm", { session: session.label }),
    confirmLabel: t("common.delete"),
    danger: true,
    ...(options.offerSkip ? { skipPreference: sessionDeleteSkipPreference(scope) } : {}),
    signal: scope.signal,
  });
  // Checked ahead of `confirmed`: a retired scope aborts the dialog to `false`
  // too, so without this order the operator's lost intent would look like an
  // ordinary cancel instead of the reconnect that actually dropped it.
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.deleteSessionStale", { session: session.label }) });
    return;
  }
  if (!confirmed) {
    return;
  }
  const agentId = resolveUiSessionRowAgentId(session, scope.selectedAgentId);
  const deleteParams = {
    agentId,
    deleteTranscript: true,
    ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
    ...(session.archived === true ? { archivedOnly: true } : {}),
  };
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.delete",
      params: { key: session.key, ...deleteParams },
    })
  ) {
    return;
  }
  try {
    const outcome = await withSessionWorkspaceRecovery({
      action: "delete",
      session: { ...session, agentId },
      scope,
      isCurrent: () => host.sessionData.isSessionMutationScopeCurrent(scope),
      request: () => scope.sessions.delete(session.key, deleteParams),
    });
    if (!outcome) {
      return;
    }
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      if (outcome.worktreePreserved) {
        showToast({ message: formatPreservedWorktreesNotice([outcome.worktreePreserved]) });
      }
      return;
    }
    if (host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(agentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    if (outcome.worktreePreserved) {
      const preserved = outcome.worktreePreserved;
      const removeAccess = readSessionMethodAccess(scope.gateway.snapshot, {
        method: "worktrees.remove",
        requiredScope: "operator.admin",
      });
      if (!removeAccess.allowed) {
        window.alert(formatPreservedWorktreesNotice([preserved]));
      } else {
        const removeWorktree = await showConfirmDialog({
          message: formatPreservedWorktreeConfirmation(preserved),
          confirmLabel: t("common.remove"),
          danger: true,
          signal: scope.signal,
        });
        // Reconnect cancels the worktree prompt, not the confirmed deletion.
        // Report the preserved worktree without using the retired client.
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          showToast({
            message: formatPreservedWorktreesNotice([preserved]),
          });
          return;
        }
        if (removeWorktree) {
          try {
            const result = await scope.client.request<WorktreesRemoveResult>("worktrees.remove", {
              id: preserved.id,
              force: true,
            });
            if (result.snapshotError) {
              host.sessionData.publishSessionMutationError(scope, result.snapshotError);
            }
          } catch (error) {
            host.sessionData.publishSessionMutationError(scope, error);
          }
        }
      }
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

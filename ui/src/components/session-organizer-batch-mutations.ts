import {
  SESSIONS_PATCH_MANY_MAX_TARGETS,
  type SessionsPatchManyParams,
  type SessionsPatchManyResult,
  type SessionsPatchMutation,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  readSessionMethodAccess,
  sessionAccessRowForBatch,
  type SessionMethodAccessRequest,
} from "../lib/session-method-access.ts";
import { archiveAutomationPauseNotice } from "../lib/sessions/automation-pause.ts";
import type { SessionPatchResult } from "../lib/sessions/patch.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { requestSessionInvolvement } from "../lib/sessions/session-requests.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionPatch,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";
import {
  formatBatchSessionRemovalError,
  withSessionWorkspaceRecovery,
} from "./session-workspace-recovery.runtime.ts";

export type SessionActionRow = Pick<
  SidebarRecentSession,
  | "key"
  | "agentId"
  | "sessionId"
  | "label"
  | "pinned"
  | "archived"
  | "active"
  | "category"
  | "sharingRole"
> & { gatewayHasActiveRun?: boolean; hasActiveRun?: boolean; hasAutomation?: boolean };

export type SessionActionHost = Pick<
  SessionOrganizerControllerHost,
  "pruneSidebarSessionEntry" | "selectSession" | "sidebarSessionStatusFilter"
> & {
  readonly sessionData: Pick<
    SessionOrganizerControllerHost["sessionData"],
    "isSessionMutationScopeCurrent" | "publishSessionMutationError" | "refreshSidebarSessions"
  >;
};

/**
 * Gate a mutation on the connection's advertised method access, publishing the
 * refusal so the caller never fails silently. Shared by every session-organizer
 * runtime module, so it lives with the types they already import.
 */
export function requireSessionMutationAccess(
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
  request: SessionMethodAccessRequest,
): boolean {
  const access = readSessionMethodAccess(scope.gateway.snapshot, request);
  if (access.allowed) {
    return true;
  }
  host.sessionData.publishSessionMutationError(scope, access.reason);
  return false;
}

/**
 * Refresh each owning agent once after deferred mutations. Rows determine the
 * agent because mutations route by session key; stale scopes and failed reads
 * remain visible to the caller.
 */
async function refreshSessionsAfterBatch(
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
  rows: readonly SessionActionRow[],
): Promise<SidebarSessionMutationResult> {
  const agentIds = [
    ...new Set(rows.map((row) => resolveUiSessionRowAgentId(row, scope.selectedAgentId))),
  ];
  const refreshSidebar = host.sidebarSessionStatusFilter() !== "active";
  for (const agentId of agentIds) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    try {
      const outcome = await scope.sessions.reconcileMutation(agentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      if (outcome.status !== "refreshed") {
        if (outcome.status === "failed") {
          host.sessionData.publishSessionMutationError(scope, outcome.error);
        }
        return outcome.status;
      }
      if (refreshSidebar) {
        await host.sessionData.refreshSidebarSessions(agentId);
      }
    } catch (error) {
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      host.sessionData.publishSessionMutationError(scope, error);
      return "failed";
    }
  }
  return host.sessionData.isSessionMutationScopeCurrent(scope) ? "completed" : "stale";
}

export async function patchSessionRows(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  patch: SessionsPatchMutation,
  scope: SidebarSessionMutationScope,
  options: {
    deferListRefresh?: boolean;
    sessionScope?: boolean;
    /** Receipt observers own a connection lifetime, independent of this view scope. */
    onConfirmed?: (result: SessionsPatchManyResult, rows: readonly SessionActionRow[]) => void;
  } = {},
): Promise<SessionActionRow[] | null> {
  if (typeof patch.archived === "boolean" && rows.some((row) => !row.sessionId?.trim())) {
    host.sessionData.publishSessionMutationError(
      scope,
      "Session lifecycle action requires a durable session identity.",
    );
    return null;
  }
  const dispatched: Array<{
    rows: readonly SessionActionRow[];
    result: SessionsPatchManyResult;
  }> = [];
  let terminalError: unknown = null;
  for (let offset = 0; offset < rows.length; offset += SESSIONS_PATCH_MANY_MAX_TARGETS) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return null;
    }
    const chunkRows = rows.slice(offset, offset + SESSIONS_PATCH_MANY_MAX_TARGETS);
    const params: SessionsPatchManyParams = {
      targets: chunkRows.map((row) => ({
        key: row.key,
        agentId: resolveUiSessionRowAgentId(row, scope.selectedAgentId),
        ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      })),
      patch,
    };
    const access = readSessionMethodAccess(scope.gateway.snapshot, {
      method: "sessions.patchMany",
      params,
      sessionScope: options.sessionScope,
      session: sessionAccessRowForBatch(chunkRows),
    });
    if (!access.allowed) {
      terminalError = access.reason;
      if (dispatched.length === 0) {
        host.sessionData.publishSessionMutationError(scope, access.reason);
      }
      break;
    }
    try {
      const result = await scope.sessions.patchMany(params.targets, params.patch);
      if (!result) {
        return null;
      }
      options.onConfirmed?.(result, chunkRows);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return null;
      }
      dispatched.push({ rows: chunkRows, result });
    } catch (error) {
      terminalError = error;
      if (dispatched.length === 0) {
        host.sessionData.publishSessionMutationError(scope, error);
      }
      break;
    }
  }
  if (dispatched.length === 0) {
    return null;
  }
  if (!options.deferListRefresh) {
    const refreshResult = await refreshSessionsAfterBatch(host, scope, rows);
    if (refreshResult === "stale") {
      return null;
    }
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return null;
  }
  const errors: string[] = [];
  const successful = dispatched.flatMap(({ rows: chunkRows, result }) =>
    result.outcomes.flatMap((outcome, index) => {
      if (!outcome.ok) {
        errors.push(
          `${outcome.key}: ${formatBatchSessionRemovalError(new GatewayRequestError(outcome.error))}`,
        );
        return [];
      }
      const notice = archiveAutomationPauseNotice([outcome.automationPause]);
      if (notice?.warning) {
        errors.push(`${outcome.key}: ${notice.message}`);
      }
      const row = chunkRows[index];
      if (row?.pinned && patch.archived === true) {
        host.pruneSidebarSessionEntry(row.key);
      }
      return row ? [row] : [];
    }),
  );
  const terminalErrorMessage = terminalError === null ? "" : formatUiError(terminalError);
  if (terminalErrorMessage) {
    errors.push(terminalErrorMessage);
  }
  if (errors.length > 0) {
    host.sessionData.publishSessionMutationError(scope, errors.join("; "));
  }
  return successful;
}

/** A personal list choice is not an archive or a shared-session mutation. */
export async function setSessionInvolvement(
  host: SessionActionHost,
  session: SessionActionRow,
  hidden: boolean,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope) || !session.sessionId) {
    return;
  }
  const agentId = resolveUiSessionRowAgentId(session, scope.selectedAgentId);
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.setInvolvement",
      requiredScope: "operator.read",
    })
  ) {
    return;
  }
  try {
    await requestSessionInvolvement(scope.client, {
      key: session.key,
      agentId,
      expectedSessionId: session.sessionId,
      hidden,
    });
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    scope.sessions.patchRowLocal(
      session.key,
      { hiddenFromInvolvingMe: hidden },
      {
        agentId,
        sessionId: session.sessionId,
      },
    );
    await host.sessionData.refreshSidebarSessions(agentId);
  } catch (error) {
    if (host.sessionData.isSessionMutationScopeCurrent(scope)) {
      host.sessionData.publishSessionMutationError(scope, error);
    }
  }
}

export async function patchSession(
  host: SessionActionHost,
  session: SessionActionRow,
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
  refresh: {
    deferListRefresh?: boolean;
    sessionScope?: boolean;
    onConfirmed?: (result: SessionPatchResult) => void;
  } = {},
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
  if (
    (typeof patch.archived === "boolean" || patch.snoozedUntil !== undefined) &&
    !session.sessionId?.trim()
  ) {
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
  const receiptConnection = refresh.onConfirmed ? scope.sessions.captureConnectionScope() : null;
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
    if (
      patched &&
      receiptConnection &&
      scope.sessions.isConnectionScopeCurrent(receiptConnection)
    ) {
      refresh.onConfirmed?.(patched);
    }
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
    const notice = archiveAutomationPauseNotice([patched.automationPause]);
    if (notice?.warning) {
      host.sessionData.publishSessionMutationError(scope, notice.message);
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

export function sessionUndoHost(
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

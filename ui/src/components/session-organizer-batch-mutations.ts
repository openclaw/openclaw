import {
  SESSIONS_PATCH_MANY_MAX_TARGETS,
  type SessionsPatchManyParams,
  type SessionsPatchManyResult,
  type SessionsPatchMutation,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { requestSessionInvolvement } from "../lib/sessions/session-requests.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";
import { formatBatchSessionRemovalError } from "./session-workspace-recovery.runtime.ts";

export type SessionActionRow = Pick<
  SidebarRecentSession,
  "key" | "agentId" | "sessionId" | "label" | "pinned" | "archived" | "active" | "category"
> & { gatewayHasActiveRun?: boolean; hasActiveRun?: boolean };

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
  request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  },
): boolean {
  const access = readSessionMethodAccess(scope.gateway.snapshot, request);
  if (access.allowed) {
    return true;
  }
  host.sessionData.publishSessionMutationError(scope, access.reason);
  return false;
}

export function sessionRowAgentId(
  session: Pick<SessionActionRow, "key" | "agentId">,
  scope: SidebarSessionMutationScope,
): string {
  return resolveUiSessionRowAgentId(session, scope.selectedAgentId);
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
  const agentIds = [...new Set(rows.map((row) => sessionRowAgentId(row, scope)))];
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
        agentId: sessionRowAgentId(row, scope),
        ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      })),
      patch,
    };
    const access = readSessionMethodAccess(scope.gateway.snapshot, {
      method: "sessions.patchMany",
      params,
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
      if (!result || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
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
  const agentId = sessionRowAgentId(session, scope);
  const access = readSessionMethodAccess(scope.gateway.snapshot, {
    method: "sessions.setInvolvement",
    requiredScope: "operator.read",
  });
  if (!access.allowed) {
    host.sessionData.publishSessionMutationError(scope, access.reason);
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

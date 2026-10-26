import {
  SESSIONS_PATCH_MANY_MAX_TARGETS,
  type SessionsPatchManyParams,
  type SessionsPatchManyResult,
  type SessionsPatchMutation,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  readSessionMethodAccess,
  sessionAccessRowForBatch,
  type SessionMethodAccessRequest,
} from "../lib/session-method-access.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { requestSessionInvolvement } from "../lib/sessions/session-requests.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerDependencies } from "./session-organizer.ts";
import { formatBatchSessionRemovalError } from "./session-workspace-recovery.runtime.ts";

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
> & {
  gatewayHasActiveRun?: boolean;
  hasActiveRun?: boolean;
  hasActiveSubagentRun?: boolean;
  isChild?: boolean;
  pinnable?: boolean;
  sidebarRoot?: boolean;
  hasArchiveDescendants?: boolean;
  archiveGuard?: Pick<
    SessionsPatchManyParams["targets"][number],
    "expectedSidebarRoot" | "expectedCategory" | "expectedArchived" | "expectedSidebarAncestors"
  >;
};

export type SessionActionHost = Pick<
  SessionOrganizerDependencies,
  "pruneSidebarSessionEntry" | "selectSession" | "sidebarSessionStatusFilter"
> & {
  readonly sessionData: Pick<
    SessionOrganizerDependencies["sessionData"],
    "isSessionMutationScopeCurrent" | "publishSessionMutationError" | "refreshSidebarSessions"
  >;
};

/**
 * Gate a mutation on the connection's advertised method access, publishing the
 * refusal so the caller never fails silently. Shared by every session-organizer
 * runtime module, so it lives with the types they already import.
 */
export function requireSessionMutationAccess(
  deps: SessionActionHost,
  scope: SidebarSessionMutationScope,
  request: SessionMethodAccessRequest,
): boolean {
  const access = readSessionMethodAccess(scope.gateway.snapshot, request);
  if (access.allowed) {
    return true;
  }
  deps.sessionData.publishSessionMutationError(scope, access.reason);
  return false;
}

/**
 * Refresh each owning agent once after deferred mutations. Rows determine the
 * agent because mutations route by session key; stale scopes and failed reads
 * remain visible to the caller.
 */
async function refreshSessionsAfterBatch(
  deps: SessionActionHost,
  scope: SidebarSessionMutationScope,
  rows: readonly SessionActionRow[],
): Promise<SidebarSessionMutationResult> {
  const agentIds = [
    ...new Set(rows.map((row) => resolveUiSessionRowAgentId(row, scope.selectedAgentId))),
  ];
  const refreshSidebar = deps.sidebarSessionStatusFilter() !== "active";
  for (const agentId of agentIds) {
    if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    try {
      const outcome = await scope.sessions.reconcileMutation(agentId);
      if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      if (outcome.status !== "refreshed") {
        if (outcome.status === "failed") {
          deps.sessionData.publishSessionMutationError(scope, outcome.error);
        }
        return outcome.status;
      }
      if (refreshSidebar) {
        await deps.sessionData.refreshSidebarSessions(agentId);
      }
    } catch (error) {
      if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      deps.sessionData.publishSessionMutationError(scope, error);
      return "failed";
    }
  }
  return deps.sessionData.isSessionMutationScopeCurrent(scope) ? "completed" : "stale";
}

export async function patchSessionRows(
  deps: SessionActionHost,
  rows: readonly SessionActionRow[],
  patch: SessionsPatchMutation,
  scope: SidebarSessionMutationScope,
  options: {
    deferListRefresh?: boolean;
    sessionScope?: boolean;
  } = {},
): Promise<SessionActionRow[] | null> {
  if (typeof patch.archived === "boolean" && rows.some((row) => !row.sessionId?.trim())) {
    deps.sessionData.publishSessionMutationError(
      scope,
      "Session lifecycle action requires a durable session identity.",
    );
    return null;
  }
  const snapshot = scope.gateway.snapshot;
  if (
    typeof patch.archived === "boolean" &&
    Object.keys(patch).length === 1 &&
    !rows.some((row) => row.archiveGuard) &&
    (snapshot.phase !== "connected" ||
      snapshot.deferredIntentCount ||
      snapshot.deferredIntentDraining)
  ) {
    const accepted: SessionActionRow[] = [];
    for (const row of rows) {
      if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
        return null;
      }
      const params = {
        key: row.key,
        agentId: resolveUiSessionRowAgentId(row, scope.selectedAgentId),
        expectedSessionId: row.sessionId,
        ...patch,
      };
      if (
        !requireSessionMutationAccess(deps, scope, {
          method: "sessions.patch",
          params,
          session: row,
          sessionScope: options.sessionScope,
          allowDeferred: true,
        })
      ) {
        return null;
      }
      const result = await scope.sessions.patch(row.key, patch, {
        agentId: params.agentId,
        expectedSessionId: row.sessionId,
        onConfirmed: () => {
          if (patch.archived) {
            deps.pruneSidebarSessionEntry(row.key);
          }
        },
      });
      if (result) {
        accepted.push(row);
      }
    }
    return accepted;
  }
  const dispatched: Array<{
    rows: readonly SessionActionRow[];
    result: SessionsPatchManyResult;
  }> = [];
  let terminalError: unknown = null;
  for (let offset = 0; offset < rows.length; offset += SESSIONS_PATCH_MANY_MAX_TARGETS) {
    if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
      return null;
    }
    const chunkRows = rows.slice(offset, offset + SESSIONS_PATCH_MANY_MAX_TARGETS);
    const params: SessionsPatchManyParams = {
      targets: chunkRows.map((row) => ({
        key: row.key,
        agentId: resolveUiSessionRowAgentId(row, scope.selectedAgentId),
        ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
        ...(patch.archived === true ? row.archiveGuard : {}),
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
        deps.sessionData.publishSessionMutationError(scope, access.reason);
      }
      break;
    }
    try {
      const result = await scope.sessions.patchMany(params.targets, params.patch);
      if (!result || !deps.sessionData.isSessionMutationScopeCurrent(scope)) {
        return null;
      }
      dispatched.push({ rows: chunkRows, result });
    } catch (error) {
      terminalError = error;
      if (dispatched.length === 0) {
        deps.sessionData.publishSessionMutationError(scope, error);
      }
      break;
    }
  }
  if (dispatched.length === 0) {
    return null;
  }
  if (!options.deferListRefresh) {
    const refreshResult = await refreshSessionsAfterBatch(deps, scope, rows);
    if (refreshResult === "stale") {
      return null;
    }
  }
  if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
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
      if (row && patch.archived === true) {
        deps.pruneSidebarSessionEntry(row.key);
      }
      return row ? [row] : [];
    }),
  );
  const terminalErrorMessage = terminalError === null ? "" : formatUiError(terminalError);
  if (terminalErrorMessage) {
    errors.push(terminalErrorMessage);
  }
  if (errors.length > 0) {
    deps.sessionData.publishSessionMutationError(scope, errors.join("; "));
  }
  return successful;
}

/** A personal list choice is not an archive or a shared-session mutation. */
export async function setSessionInvolvement(
  deps: SessionActionHost,
  session: SessionActionRow,
  hidden: boolean,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  if (!deps.sessionData.isSessionMutationScopeCurrent(scope) || !session.sessionId) {
    return;
  }
  const agentId = resolveUiSessionRowAgentId(session, scope.selectedAgentId);
  if (
    !requireSessionMutationAccess(deps, scope, {
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
    if (!deps.sessionData.isSessionMutationScopeCurrent(scope)) {
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
    await deps.sessionData.refreshSidebarSessions(agentId);
  } catch (error) {
    if (deps.sessionData.isSessionMutationScopeCurrent(scope)) {
      deps.sessionData.publishSessionMutationError(scope, error);
    }
  }
}

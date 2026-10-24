import { isSessionDisplayMetadataPatch } from "../lib/sessions/patch.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
  SidebarSessionPatch,
} from "./app-sidebar-session-types.ts";
import { requireSessionMutationAccess } from "./session-organizer-batch-mutations.ts";
import type { SessionActionHost, SessionActionRow } from "./session-organizer-batch-mutations.ts";
import { withSessionWorkspaceRecovery } from "./session-workspace-recovery.runtime.ts";

export async function patchSession(
  host: SessionActionHost,
  session: SessionActionRow,
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
  refresh: {
    deferListRefresh?: boolean;
    sessionScope?: boolean;
    /** Return true when the caller presents this attempt's rejection locally. */
    handleError?: (error: unknown) => boolean;
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
      allowDeferred: isSessionDisplayMetadataPatch(patch),
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
    if ("queued" in patched) {
      return "completed";
    }
    // Personal pin references are independent of the shared session's pinnedAt.
    // Retire this profile's reference only after the archive commits.
    if (patch.pinned === false || patch.archived === true) {
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
    if (!refresh.handleError?.(error)) {
      host.sessionData.publishSessionMutationError(scope, error);
    }
    return "failed";
  }
}

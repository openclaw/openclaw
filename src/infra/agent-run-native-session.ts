/** Native discovery identity shares the admitted run lease; it is never resume authority. */
import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";
import {
  getAgentRunContext,
  listAgentRunsForSession,
  registerAgentRunContext,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";

export type AgentRunNativeSession = Readonly<{
  sessionKey: string;
  sessionId: string;
  backendId: string;
  hostId: string;
  threadId: string;
}>;

export function publishAgentRunNativeSession(
  authority: AgentRunDelegatedAuthority,
  source: AgentRunNativeSession,
): void {
  const context = getAgentRunContext(authority.operationalRunInstance.runId);
  if (
    !context ||
    !validateAgentRunDelegatedAuthority(authority) ||
    (context.sessionKey && context.sessionKey !== source.sessionKey) ||
    (context.sessionId && context.sessionId !== source.sessionId)
  ) {
    throw new Error("native session publisher no longer owns the run");
  }
  registerAgentRunContext(
    authority.operationalRunInstance.runId,
    { sessionKey: source.sessionKey, sessionId: source.sessionId },
    authority.claimId,
  );
  context.nativeSession = Object.freeze({ ...source });
}

export function listAgentRunNativeSessions(
  owner: Pick<AgentRunNativeSession, "sessionKey" | "sessionId">,
): AgentRunNativeSession[] {
  return listAgentRunsForSession(owner).flatMap(({ runId }) => {
    const context = getAgentRunContext(runId);
    const source = context?.nativeSession;
    return source &&
      source.sessionKey === owner.sessionKey &&
      source.sessionId === owner.sessionId &&
      context.projectSessionMessages !== false &&
      context.projectSessionLifecycle !== false &&
      context.delegatedAuthority &&
      validateAgentRunDelegatedAuthority(context.delegatedAuthority)
      ? [source]
      : [];
  });
}

import type { GatewayToolOperatorSelection } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import type { ResolvedStatusSessionEntry } from "./session-status-session-resolve.js";

export async function assertSessionStatusVisible(params: {
  selection: GatewayToolOperatorSelection;
  resolved: ResolvedStatusSessionEntry;
  agentId: string;
  requesterAgentId: string;
  currentSessionKey: string;
  normalizeSessionKey: (key: string, agentId: string) => string;
  requestedKey: string;
  gatewayCall: AgentToolGatewayRequestCaller;
}): Promise<void> {
  params.selection.assertCurrent();
  if (
    !params.selection.operatorAuthority ||
    !params.resolved.persisted ||
    (params.agentId === params.requesterAgentId &&
      params.normalizeSessionKey(params.resolved.key, params.agentId) ===
        params.normalizeSessionKey(params.currentSessionKey, params.requesterAgentId))
  ) {
    return;
  }
  const described = await params.gatewayCall<{ session: { sessionId?: string } | null }>({
    method: "sessions.describe",
    params: { key: params.resolved.key, agentId: params.agentId },
  });
  params.selection.assertCurrent();
  if (described.session?.sessionId !== params.resolved.entry.sessionId) {
    throw new Error(`Session not visible from session tools: ${params.requestedKey}`);
  }
}

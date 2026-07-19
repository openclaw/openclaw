/** Gateway adapter for issuing authority from the authenticated connection. */
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TurnAuthoritySnapshot } from "../plugins/authorization-policy.types.js";
import { createOperatorTurnAuthoritySnapshot } from "../plugins/turn-authority.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

export function createGatewayOperatorTurnAuthority(params: {
  client: GatewayClient | null | undefined;
  config?: OpenClawConfig;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  parentConversationId?: string | null;
  threadId?: string | number | null;
  trigger: string;
  capability?: unknown;
}): TurnAuthoritySnapshot {
  const client = params.client;
  const scopes = client?.connect?.scopes;
  const config = params.config ?? {};
  const requestedSessionKey = params.sessionKey?.trim();
  const requestedAgentId = params.agentId?.trim();
  const parsedSessionAgentId = parseAgentSessionKey(requestedSessionKey)?.agentId;
  const agentId = normalizeAgentId(
    requestedAgentId || parsedSessionAgentId || resolveDefaultAgentId(config),
  );
  const sessionKey = requestedSessionKey
    ? canonicalizeMainSessionAlias({
        cfg: config,
        agentId,
        sessionKey: requestedSessionKey,
      })
    : undefined;
  const requestedConversationId = params.conversationId?.trim();
  const conversationId =
    requestedConversationId && requestedConversationId === requestedSessionKey
      ? sessionKey
      : requestedConversationId;
  return createOperatorTurnAuthoritySnapshot({
    scopes,
    pairedClientId: client?.pairedClientId,
    deviceId: client?.connect?.device?.id,
    connectionId: client?.connId,
    isOwner: scopes?.includes(ADMIN_SCOPE) === true,
    agentId,
    sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    conversationId,
    parentConversationId: params.parentConversationId,
    threadId: params.threadId,
    trigger: params.trigger,
    capability: stableStringify({
      clientCaps: [...(client?.connect?.caps ?? [])].toSorted(),
      value: params.capability ?? null,
    }),
  });
}

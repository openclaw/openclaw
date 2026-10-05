import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { transferGatewayLocalUserIngress } from "../local-user-ingress.js";
import { transferGatewayOperatorSourceIdentity } from "../operator-run-authority.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/shared-types.js";
import type { AgentTurnPrincipal } from "./types.js";

/** Captures the transport identity without rebuilding its trusted metadata. */
export function captureAgentTurnPrincipal(client: GatewayClient | null): AgentTurnPrincipal | null {
  if (!client) {
    return null;
  }
  const principal: AgentTurnPrincipal = {
    authenticatedUserId: client.authenticatedUserId,
    authPolicy: client.authPolicy,
    authenticatedUserProfile: client.authenticatedUserProfile,
    get authenticatedFactoryGitHubAccountId() {
      return client.authenticatedFactoryGitHubAccountId;
    },
    connectionSignal: client.connectionSignal,
    get invalidated() {
      return client.invalidated;
    },
    connId: client.connId,
    connect: client.connect,
    internal: client.internal,
    isDeviceTokenAuth: client.isDeviceTokenAuth,
  };
  transferGatewayLocalUserIngress(client, principal);
  transferGatewayOperatorSourceIdentity(client, principal);
  return principal;
}

/** Preserve capability-gated tool-event observation across agent turn entry paths. */
export function resolveAgentTurnRunObserver(params: {
  principal: AgentTurnPrincipal | null;
  registerToolEventRecipient: GatewayRequestContext["registerToolEventRecipient"];
}): ((runId: string) => void) | undefined {
  const connId = params.principal?.connId;
  return connId &&
    hasGatewayClientCap(params.principal?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS)
    ? (runId) => params.registerToolEventRecipient(runId, connId)
    : undefined;
}

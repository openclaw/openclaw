import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { hiddenSessionNotFound } from "./session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "./session-sharing-read.js";
import { resolveDirectSessionTargets } from "./session-sharing-target-input.js";

export function authorizeSessionDescribe(params: {
  client: GatewayClient | null;
  requestParams: unknown;
  context: GatewayRequestContext;
  sessionRowRead?: SessionRowReadView;
}): ErrorShape | null {
  const projection = params.sessionRowRead ?? getSessionRowProjection(params.context);
  if (!projection) {
    return null;
  }
  const { cfg, policyConfig } = projection.state;
  for (const target of resolveDirectSessionTargets("sessions.describe", params.requestParams)) {
    const agent = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
    if (!agent.ok) {
      return agent.error;
    }
    const row = projection.describe({ key: target.sessionKey, agentId: agent.agentId });
    const sharing = prepareProjectedSessionSharing({
      cfg: policyConfig,
      client: params.client,
      isMember: (_target, identityId) => row?.membership.has(identityId) ?? false,
    });
    if (
      row &&
      gatewayClientSessionCreator(params.client) &&
      sharing.sessionCap === "none" &&
      !sharing.isCreator(row.entry.createdActor)
    ) {
      return hiddenSessionNotFound(target.sessionKey);
    }
  }
  return null;
}

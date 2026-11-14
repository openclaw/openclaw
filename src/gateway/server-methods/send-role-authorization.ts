import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isNamedOperatorRoleEnforcementEnabled } from "../operator-role-enforcement.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { GatewayClient } from "./shared-types.js";

export function authorizeMessageActionSendAgent(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  agentId?: string;
}) {
  // Default-agent resolution may fail, so role-free sends must not enter this policy path.
  if (!isNamedOperatorRoleEnforcementEnabled(params.cfg)) {
    return undefined;
  }
  const agent = params.agentId ?? resolveRequestedSessionAgentId(params.cfg, "main");
  if (typeof agent !== "string" && !agent.ok) {
    return agent.error;
  }
  return authorizeGatewaySessionCreation({
    cfg: params.cfg,
    client: params.client,
    agentId: typeof agent === "string" ? agent : agent.agentId,
  });
}

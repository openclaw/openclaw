import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  authorizeGatewaySessionCreation,
  resolveOperatorRolePolicy,
} from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { GatewayClient } from "./shared-types.js";

export function authorizeMessageActionSendAgent(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  agentId?: string;
}) {
  const policy = resolveOperatorRolePolicy(params.client, params.cfg);
  // ID membership can restrict agents without a local named-role default.
  // Unrestricted sends must still avoid potentially failing default-agent resolution.
  if (!policy || policy.agents === "*") {
    return undefined;
  }
  const agent = params.agentId ?? resolveRequestedSessionAgentId(params.cfg, "main");
  if (typeof agent !== "string" && !agent.ok) {
    return agent.error;
  }
  return authorizeGatewaySessionCreation(
    {
      cfg: params.cfg,
      client: params.client,
      agentId: typeof agent === "string" ? agent : agent.agentId,
    },
    { policy },
  );
}

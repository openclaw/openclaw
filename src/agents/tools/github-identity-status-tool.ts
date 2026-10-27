import { Type } from "typebox";
import type { ToolsGitHubStatusResult } from "../../../packages/gateway-protocol/src/index.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

const GITHUB_IDENTITY_STATUS_PARAMETERS = Type.Object({}, { additionalProperties: false });

export function createGitHubIdentityStatusTool(
  options: { callGateway?: InProcessGatewayCaller } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "GitHub Identity Status",
    name: "github_identity_status",
    description:
      "Inspect the secret-free effective GitHub account, credential health, Git author, expiry, and scopes for this agent. If setup or reconnection is needed, ask the operator to connect GitHub in Agent Settings.",
    parameters: GITHUB_IDENTITY_STATUS_PARAMETERS,
    execute: async () => {
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.agentId) {
        throw new Error("GitHub identity status requires the current Gateway agent.");
      }
      const status = await callGateway<ToolsGitHubStatusResult>("tools.github.status", {
        agentId: caller.agentId,
        selectedScope: "agent",
      });
      const reconnect =
        status.effective.credentialState !== "available" ||
        ["expired", "failed", "unavailable"].includes(status.effective.refreshState);
      return jsonResult({
        ...status,
        ...(reconnect
          ? {
              nextAction:
                "Ask the operator to connect or reconnect GitHub under Settings → Agents → Tools.",
            }
          : {}),
      });
    },
  };
}

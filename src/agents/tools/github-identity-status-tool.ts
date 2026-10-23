import { Type } from "typebox";
import type { ToolsGitHubStatusResult } from "../../../packages/gateway-protocol/src/index.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

export function createGitHubIdentityStatusTool(
  options: {
    callGateway?: InProcessGatewayCaller;
    githubIdentitySettingsAvailable?: boolean;
  } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "GitHub Identity Status",
    name: "github_identity_status",
    description: `Inspect the secret-free effective GitHub account, credential health, Git author, expiry, and scopes for this agent.${options.githubIdentitySettingsAvailable ? " If setup or reconnection is needed, open github_identity_settings so the operator can reconnect in the masked Control UI flow." : ""}`,
    parameters: Type.Object({}, { additionalProperties: false }),
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
              nextAction: options.githubIdentitySettingsAvailable
                ? "Use screen action github_identity_settings to open the masked operator reconnect flow, then check github_identity_status again."
                : "Ask the operator to open Settings → Agents → Tools, reconnect GitHub, then check github_identity_status again.",
            }
          : {}),
      });
    },
  };
}

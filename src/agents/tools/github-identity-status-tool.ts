import { Type } from "typebox";
import type { ToolsGitHubStatusResult } from "../../../packages/gateway-protocol/src/index.js";
import { bindAgentToolAvailability } from "../agent-tool-availability.js";
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
  let githubIdentitySettingsAvailable = options.githubIdentitySettingsAvailable === true;
  let githubIdentitySettingsOffered = githubIdentitySettingsAvailable;
  const tool: AnyAgentTool = {
    label: "GitHub Identity Status",
    name: "github_identity_status",
    description: githubIdentityStatusDescription(githubIdentitySettingsOffered),
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
              nextAction: githubIdentitySettingsAvailable
                ? "Use screen action github_identity_settings to open the masked operator reconnect flow, then check github_identity_status again."
                : "Ask the operator to open Settings → Agents → Tools, reconnect GitHub, then check github_identity_status again.",
            }
          : {}),
      });
    },
  };
  return bindAgentToolAvailability(tool, {
    prepare(preparedTool, callableTools, offeredTools) {
      const callableScreen = callableTools.get("screen");
      const offeredScreen = offeredTools.get("screen");
      githubIdentitySettingsAvailable =
        options.githubIdentitySettingsAvailable === true &&
        callableScreen !== undefined &&
        schemaIncludesAction(callableScreen.parameters, "github_identity_settings");
      githubIdentitySettingsOffered =
        options.githubIdentitySettingsAvailable === true &&
        offeredScreen !== undefined &&
        schemaIncludesAction(offeredScreen.parameters, "github_identity_settings");
      preparedTool.description = githubIdentityStatusDescription(githubIdentitySettingsOffered);
    },
  });
}

function githubIdentityStatusDescription(settingsAvailable: boolean): string {
  return `Inspect the secret-free effective GitHub account, credential health, Git author, expiry, and scopes for this agent.${settingsAvailable ? " If setup or reconnection is needed, open github_identity_settings so the operator can reconnect in the masked Control UI flow." : ""}`;
}

function schemaIncludesAction(schema: unknown, expected: string): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const properties = Reflect.get(schema, "properties");
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const action = Reflect.get(properties, "action");
    if (action && typeof action === "object" && !Array.isArray(action)) {
      const values = Reflect.get(action, "enum");
      if (Array.isArray(values) && values.includes(expected)) {
        return true;
      }
    }
  }
  return ["anyOf", "oneOf", "allOf"].some((key) => {
    const variants = Reflect.get(schema, key);
    return (
      Array.isArray(variants) && variants.some((variant) => schemaIncludesAction(variant, expected))
    );
  });
}

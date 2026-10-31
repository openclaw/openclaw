import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import type { ToolsGitHubStatusResult } from "../../../packages/gateway-protocol/src/index.js";
import { bindAgentToolAvailability } from "../agent-tool-availability.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

const GITHUB_IDENTITY_STATUS_PARAMETERS = Type.Object({}, { additionalProperties: false });

export function createGitHubIdentityStatusTool(
  options: {
    callGateway?: InProcessGatewayCaller;
    clientCaps?: string[];
  } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  let githubIdentitySettingsAvailable =
    options.clientCaps?.includes("ui-agent-github-settings") === true;
  const tool: AnyAgentTool = {
    label: "GitHub Identity Status",
    name: "github_identity_status",
    description: githubIdentityStatusDescription(githubIdentitySettingsAvailable),
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
        options.clientCaps?.includes("ui-agent-github-settings") === true &&
        callableScreen !== undefined &&
        schemaIncludesAction(callableScreen.parameters, "github_identity_settings");
      const githubIdentitySettingsOffered =
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
  const properties = isRecord(schema) ? schema.properties : undefined;
  const action = isRecord(properties) ? properties.action : undefined;
  return isRecord(action) && Array.isArray(action.enum) && action.enum.includes(expected);
}

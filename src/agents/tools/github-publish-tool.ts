import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../../packages/agent-core/src/tool-execution-context.js";
import {
  GitHubPublicationBodySchema,
  GitHubPublicationTitleSchema,
  type SessionGitHubPublicationResult,
  type SessionGitHubPublishParams,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { bindAgentToolAvailability } from "../agent-tool-availability.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

function describeGitHubPublishTool(automationsAvailable: boolean): string {
  const continuation = automationsAvailable
    ? 'schedule a continuation into this conversation before ending the turn (automations: at + agentTurn + sessionTarget "session:<this session key from Runtime>")'
    : "continue that work before ending the turn, or explain that a scheduled continuation is unavailable";
  return `Publish the current session's repository changes as a draft pull request. Supports local workspaces and cloud repository sessions without a Gateway checkout. Call when the source changes are ready, then finish the turn so its changes can be saved. The Gateway publishes the accepted workspace, creates or reuses the draft pull request, and posts the result into the session transcript without resuming the agent. If review, CI, or landing remains in the authorized task, ${continuation}; a publication receipt is not completion of that work. Requests wait while the workspace is busy or recovering. Publication credentials stay on the Gateway.`;
}

export function createGitHubPublishTool(
  options: {
    callGateway?: InProcessGatewayCaller;
  } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  const tool: AnyAgentTool = {
    label: "GitHub Publish",
    name: "github_publish",
    description: describeGitHubPublishTool(false),
    parameters: Type.Object(
      {
        title: Type.Optional(GitHubPublicationTitleSchema),
        body: Type.Optional(GitHubPublicationBodySchema),
      },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, rawArgs) => {
      // SAFETY: the tool runtime validates rawArgs against the closed schema above.
      const input = rawArgs as Omit<SessionGitHubPublishParams, "idempotencyKey" | "sessionKey">;
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey) {
        throw new Error("GitHub publication requires the current Gateway session.");
      }
      // The persisted assistant turn keeps replays stable, even when recovery runs them again.
      const assistantTurnId = getAgentToolAssistantTurnId();
      const result = await callGateway<SessionGitHubPublicationResult>("sessions.github.publish", {
        sessionKey: caller.sessionKey,
        idempotencyKey: assistantTurnId ? `${assistantTurnId}:${toolCallId}` : toolCallId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.body ? { body: input.body } : {}),
      });
      return jsonResult(result);
    },
  };
  return bindAgentToolAvailability(tool, {
    prepare: (preparedTool, callableTools) => {
      const schema = callableTools.get("automations")?.parameters;
      const properties = isRecord(schema) ? schema.properties : undefined;
      const action = isRecord(properties) ? properties.action : undefined;
      const actions = isRecord(action) ? action.enum : undefined;
      preparedTool.description = describeGitHubPublishTool(
        Array.isArray(actions) && actions.includes("add"),
      );
    },
  });
}

import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../../packages/agent-core/src/tool-execution-context.js";
import {
  GitHubPublicationBodySchema,
  GitHubPublicationTitleSchema,
  type SessionGitHubPublicationResult,
  type SessionGitHubPublishParams,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

export function createGitHubPublishTool(
  options: {
    callGateway?: InProcessGatewayCaller;
  } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "GitHub Publish",
    name: "github_publish",
    description:
      "Publish the current session's repository changes as a draft pull request. Supports local workspaces and cloud repository sessions without a Gateway checkout. Call when the source changes are ready, then finish the turn so its changes can be saved. The Gateway publishes the accepted workspace, creates or reuses the draft pull request, and posts the result into the session transcript without resuming the agent. If review, CI, or landing remains in the authorized task, arrange a continuation before ending the turn; a publication receipt is not completion of that work. Requests wait while the workspace is busy or recovering. Publication credentials stay on the Gateway.",
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
}

export function createGitHubPullRequestReadTool(
  options: { callGateway?: InProcessGatewayCaller } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "GitHub Pull Request Read",
    name: "github_pull_request_read",
    description:
      "Read one pull request from this session's bound repository through the Gateway-owned GitHub credential. Returns bounded untrusted PR, file, and review content. Issue-conversation comments are reported unavailable when the installed credential lacks issue-read permission.",
    parameters: Type.Object(
      { pull_request: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }) },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawArgs) => {
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey || !caller.agentId) {
        throw new Error("GitHub pull request reads require the current Gateway session.");
      }
      // SAFETY: The tool runtime validates rawArgs against the closed integer schema before execution.
      const input = rawArgs as { pull_request: number };
      const result = await callGateway("sessions.github.pullRequest.read", {
        sessionKey: caller.sessionKey,
        agentId: caller.agentId,
        pullRequest: input.pull_request,
      });
      return jsonResult(result);
    },
  };
}

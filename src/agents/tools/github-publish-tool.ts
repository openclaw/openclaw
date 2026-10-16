import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../../packages/agent-core/src/tool-execution-context.js";
import {
  GitHubPublicationBodySchema,
  GitHubBaseRefreshSchema,
  type SessionGitHubBaseRefreshResult,
  GitHubPublicationActionSchema,
  GitHubPublicationTitleSchema,
  type GitHubPublicationAction,
  type SessionGitHubActionResult,
  type SessionGitHubPublicationResult,
  type SessionGitHubPublishParams,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { bindAgentToolAvailability } from "../agent-tool-availability.js";
import type { SandboxContext } from "../sandbox/types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import {
  withGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

function describeGitHubPublishTool(
  automationsAvailable: boolean,
  publicationAvailable: boolean,
  actionsAvailable: boolean,
): string {
  const continuation = automationsAvailable
    ? 'schedule a continuation into this conversation before ending the turn (automations: at + agentTurn + sessionTarget "session:<this session key from Runtime>")'
    : "continue that work before ending the turn, or explain that a scheduled continuation is unavailable";
  const publication = publicationAvailable
    ? `Publish the current session's repository changes as a draft pull request. Supports local workspaces and cloud repository sessions without a Gateway checkout. Call when the source changes are ready, then finish the turn so its changes can be saved. The Gateway publishes the accepted workspace, creates or reuses the draft pull request, and posts the result into the session transcript without resuming the agent. If review, CI, or landing remains in the authorized task, ${continuation}; a publication receipt is not completion of that work. Requests wait while the workspace is busy or recovering. Publication credentials stay on the Gateway. Before tests and Auto Review, refresh_base explicitly integrates the selected repository base into an existing local managed sandbox workspace. It preserves saved work and returns changed/conflicting paths. Resolve conflicts, then repeat refresh_base with conflictsResolved: true and its returned baseCommit to acknowledge that exact integration, including an unchanged binary choice. A retry without acknowledgment keeps conflicts pending. Refresh never publishes, changes GitHub PR state, or accepts another repository/ref/session selector. A completed refresh imports only the selected base snapshot and stages the current source inside the sandbox while preserving guest HEAD, branches and commits. Run tests, then Auto Review with the returned review target (mode local and exact base), before publication; default review against the old guest HEAD includes upstream-only changes.`
    : "This conversation cannot publish its own workspace. It can act on an explicitly selected publishing child's PR.";
  return actionsAvailable
    ? `${publication} For an explicit landing request from a person with full operator write access, use inspect, then ready and merge after review and required checks. For an explicit closure request, use close to close the PR without merging or deleting saved work. ready, merge and close require the inspected requestId and expectedHeadCommit; merge also requires mergeMethod. For delegated work, explicitly select its publishingSessionKey from this conversation's children; never guess a PR. Actions return the observed GitHub state and never enable auto-merge. Inspect after an uncertain response before retrying. Guest requests cannot use these privileged actions. Actions do not change session sandboxing.`
    : publication;
}

export function createGitHubPublishTool(
  options: {
    callGateway?: InProcessGatewayCaller;
    publicationAvailable?: boolean;
    actionsAvailable?: boolean;
    sandbox?: SandboxContext | null;
  } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  const publicationAvailable = options.publicationAvailable !== false;
  const actionsAvailable = options.actionsAvailable === true;
  const tool: AnyAgentTool = {
    label: "GitHub Publish",
    name: "github_publish",
    description: describeGitHubPublishTool(false, publicationAvailable, actionsAvailable),
    parameters: publicationAvailable
      ? Type.Object(
          {
            ...(actionsAvailable
              ? {
                  ...GitHubPublicationActionSchema.properties,
                }
              : {}),
            ...GitHubBaseRefreshSchema.properties,
            action: actionsAvailable
              ? Type.Optional(
                  Type.Union([
                    Type.Literal("publish"),
                    Type.Literal("refresh_base"),
                    ...GitHubPublicationActionSchema.properties.action.anyOf,
                  ]),
                )
              : Type.Optional(Type.Literal("refresh_base")),
            title: Type.Optional(GitHubPublicationTitleSchema),
            body: Type.Optional(GitHubPublicationBodySchema),
          },
          { additionalProperties: false },
        )
      : GitHubPublicationActionSchema,
    execute: async (toolCallId, rawArgs) => {
      // SAFETY: the tool runtime validates rawArgs against the closed schema above.
      const input = rawArgs as Omit<SessionGitHubPublishParams, "idempotencyKey" | "sessionKey"> &
        Omit<GitHubPublicationAction, "action"> & {
          action?: "publish" | "refresh_base" | GitHubPublicationAction["action"];
          conflictsResolved?: boolean;
          baseCommit?: string;
        };
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey) {
        throw new Error("GitHub publication requires the current Gateway session.");
      }
      if (input.action === "refresh_base") {
        if (
          !publicationAvailable ||
          input.publishingSessionKey ||
          input.requestId ||
          input.expectedHeadCommit ||
          input.mergeMethod ||
          input.title ||
          input.body
        ) {
          throw new Error(
            "refresh_base only prepares the current workspace; it accepts no publication target or PR action fields.",
          );
        }
        return jsonResult(
          await withGatewayToolCallerIdentity(
            { ...caller, workspaceBaseRefreshSandbox: options.sandbox ?? undefined },
            () =>
              callGateway<SessionGitHubBaseRefreshResult>("sessions.github.action", {
                sessionKey: caller.sessionKey,
                action: "refresh_base",
                ...(input.conflictsResolved !== undefined
                  ? { conflictsResolved: input.conflictsResolved }
                  : {}),
                ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
              }),
          ),
        );
      }
      if (input.action && input.action !== "publish") {
        return jsonResult(
          await callGateway<SessionGitHubActionResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action: input.action,
            ...(input.publishingSessionKey
              ? { publishingSessionKey: input.publishingSessionKey }
              : {}),
            ...(input.requestId ? { requestId: input.requestId } : {}),
            ...(input.expectedHeadCommit ? { expectedHeadCommit: input.expectedHeadCommit } : {}),
            ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
          }),
        );
      }
      if (!publicationAvailable) {
        throw new Error(
          "This session cannot publish its workspace; select a publishing child and an explicit PR action.",
        );
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
        publicationAvailable,
        actionsAvailable,
      );
    },
  });
}

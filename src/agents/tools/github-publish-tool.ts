import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../../packages/agent-core/src/tool-execution-context.js";
import {
  GitHubBaseRefreshSchema,
  type SessionGitHubBaseRefreshResult,
  GitHubPublicationActionSchema,
  GitHubPublicationEditSchema,
  type GitHubPublicationEdit,
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
    ? `Publish or edit the current session's PR through Gateway-held credentials, for local or cloud repository workspaces.
- Omitted action: publish accepted workspace changes as a draft PR; title/body are used only when creating a PR. Finish the turn so changes can be saved. Busy/recovering workspaces wait; the receipt arrives in this conversation without resuming the agent. If authorized review, CI or landing remains, ${continuation}; a receipt does not complete it.
- edit: omit title/body to read current metadata. To change either field, send requestId, expectedHeadCommit, and its new value with the observed expectedTitle/expectedBody. Keep attribution, marker and footer unchanged in the full body. Omitted fields stay unchanged. Edit never synchronizes, stages, commits or pushes files or changes PR state. Read with edit after an uncertain response before retrying.
- refresh_base: integrate the selected base into this local managed sandbox before tests and Auto Review. Resolve returned conflicts, then acknowledge with conflictsResolved: true and the returned baseCommit, including unchanged binary choices. Tests and Auto Review use the returned exact review base (mode local). Refresh stages source but preserves guest HEAD/branches/commits and never publishes.
Edit and refresh accept no other repository, PR, ref or publishing session.`
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
            ...GitHubPublicationEditSchema.properties,
            action: actionsAvailable
              ? Type.Optional(
                  Type.Union([
                    Type.Literal("publish"),
                    Type.Literal("refresh_base"),
                    Type.Literal("edit"),
                    ...GitHubPublicationActionSchema.properties.action.anyOf,
                  ]),
                )
              : Type.Optional(Type.Union([Type.Literal("refresh_base"), Type.Literal("edit")])),
            title: Type.Optional(GitHubPublicationTitleSchema),
            body: GitHubPublicationEditSchema.properties.body,
          },
          { additionalProperties: false },
        )
      : GitHubPublicationActionSchema,
    execute: async (toolCallId, rawArgs) => {
      // SAFETY: the tool runtime validates rawArgs against the closed schema above.
      const input = rawArgs as Omit<SessionGitHubPublishParams, "idempotencyKey" | "sessionKey"> &
        Omit<GitHubPublicationAction, "action"> &
        Omit<GitHubPublicationEdit, "action"> & {
          action?: "publish" | "refresh_base" | "edit" | GitHubPublicationAction["action"];
          conflictsResolved?: boolean;
          baseCommit?: string;
        };
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey) {
        throw new Error("GitHub publication requires the current Gateway session.");
      }
      if (input.action === "edit") {
        if (
          !publicationAvailable ||
          input.publishingSessionKey !== undefined ||
          input.mergeMethod !== undefined ||
          input.conflictsResolved !== undefined ||
          input.baseCommit !== undefined
        ) {
          throw new Error("edit only reads or changes the current session PR's title and body.");
        }
        return jsonResult(
          await callGateway<SessionGitHubActionResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action: "edit",
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
            ...(input.expectedHeadCommit !== undefined
              ? { expectedHeadCommit: input.expectedHeadCommit }
              : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.expectedTitle !== undefined ? { expectedTitle: input.expectedTitle } : {}),
            ...(input.expectedBody !== undefined ? { expectedBody: input.expectedBody } : {}),
          }),
        );
      }
      if (input.expectedTitle !== undefined || input.expectedBody !== undefined) {
        throw new Error("Use action edit for PR metadata preconditions; publish changes source.");
      }
      if (input.action === "refresh_base") {
        if (
          !publicationAvailable ||
          input.publishingSessionKey ||
          input.requestId ||
          input.expectedHeadCommit ||
          input.mergeMethod ||
          input.title !== undefined ||
          input.body !== undefined
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
        ...(input.body !== undefined ? { body: input.body } : {}),
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

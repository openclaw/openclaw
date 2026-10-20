import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../../packages/agent-core/src/tool-execution-context.js";
import {
  GitHubBaseRefreshSchema,
  type SessionGitHubBaseRefreshResult,
  GitHubPublicationActionSchema,
  GitHubPublicationEditSchema,
  type GitHubPublicationEdit,
  GitHubPublicationEvidenceSchema,
  type GitHubPublicationEvidence,
  GitHubPublicationTitleSchema,
  type GitHubPublicationAction,
  type SessionGitHubActionResult,
  type SessionGitHubPublicationResult,
  type SessionGitHubPublishParams,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { bindAgentToolAvailability } from "../agent-tool-availability.js";
import {
  canRefreshGitHubPublicationBase,
  canUploadGitHubPublicationEvidence,
} from "../sandbox/github-publication.js";
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
  refreshBaseAvailable: boolean,
  evidenceAvailable: boolean,
): string {
  const continuation = automationsAvailable
    ? 'schedule a continuation into this conversation before ending the turn (automations: at + agentTurn + sessionTarget "session:<this session key from Runtime>"). While that scheduled continuation waits, use automations next_check to rearm its existing job, not add another job'
    : "continue that work before ending the turn, or explain that a scheduled continuation is unavailable";
  const publication = publicationAvailable
    ? `Publish or edit the current session's PR through Gateway-held credentials, for local or cloud repository workspaces.
- Omitted action: publish accepted workspace changes as an open PR by default; draft: true creates a draft. title/body and draft are used only when creating a PR. Updating an existing PR preserves its state. Finish the turn so changes can be saved. Busy/recovering workspaces wait; the receipt arrives in this conversation without resuming the agent. If authorized review, CI or landing remains, ${continuation}; a receipt does not complete it.
- edit: omit title/body to read current metadata. To change either field, send requestId, expectedHeadCommit, and its new value with the observed expectedTitle/expectedBody. Keep attribution, marker and footer unchanged in the full body. Omitted fields stay unchanged. Edit never synchronizes, stages, commits or pushes files or changes PR state. Read with edit after an uncertain response before retrying.
- ready: mark the current session's own draft ready for review, using the requestId and expectedHeadCommit observed with edit. After an uncertain response, read with edit before retrying. This does not merge the PR.
- request_review: after an explicit re-review request, read the current PR with edit, then send requestId and expectedHeadCommit to post only "@clawsweeper re-review". No comment text, focus or child target is accepted. Posting is not review acceptance or completion. If the response is uncertain, read existing PR comments before any new request; never retry blindly.
${evidenceAvailable ? "- upload_evidence: upload one inspected image/video from this conversation's sandbox workspace to its existing GitHub.com PR repository. First read the PR with edit; send its requestId/expectedHeadCommit and evidence {path: workspace-relative path, sha256: inspected lowercase SHA-256, sizeBytes: inspected byte count, at most 10 MB}. Supports PNG, JPEG, GIF, WebP, MP4, MOV and WebM. Only the inspected bytes are sent. Use the returned uploaded URL with edit to associate it in the PR body, then verify reviewer access; uploaded does not prove public access. An unconfirmed result may have created an attachment: never repeat the upload blindly. No host credentials, other mounts, remote URLs, repository or PR selectors are accepted.\n" : ""}${refreshBaseAvailable ? "- refresh_base: integrate the selected base into this local managed sandbox before tests and Auto Review. Resolve returned conflicts, then acknowledge with conflictsResolved: true and the returned baseCommit, including unchanged binary choices. Tests and Auto Review use the returned exact review base (mode local). Refresh stages source but preserves guest HEAD/branches/commits and never publishes.\n" : ""}Edit${evidenceAvailable ? ", upload_evidence" : ""}, request_review${refreshBaseAvailable ? ", refresh_base" : ""} and own-draft readiness accept no other repository, PR, ref or publishing session.`
    : "This conversation cannot publish its own workspace. It can act on an explicitly selected publishing child's PR.";
  return actionsAvailable
    ? `${publication} For an explicit landing request from a person with full operator write access, use inspect, then ready and merge after review and required checks. For an explicit closure request, use close to close the PR without merging or deleting saved work. ready, merge and close require the inspected requestId and expectedHeadCommit; merge also requires mergeMethod. For delegated work, explicitly select its publishingSessionKey from this conversation's children; never guess a PR. Actions return the observed GitHub state and never enable auto-merge. Inspect after an uncertain response before retrying. Guests may only mark their own draft ready; inspection, merge, close and child selection require full operator write access. Actions do not change session sandboxing.`
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
  const refreshBaseAvailable = canRefreshGitHubPublicationBase(options.sandbox);
  const evidenceAvailable = canUploadGitHubPublicationEvidence(options.sandbox);
  const tool: AnyAgentTool = {
    label: "GitHub Publish",
    name: "github_publish",
    description: describeGitHubPublishTool(
      false,
      publicationAvailable,
      actionsAvailable,
      refreshBaseAvailable,
      evidenceAvailable,
    ),
    parameters: publicationAvailable
      ? Type.Object(
          {
            ...(actionsAvailable
              ? {
                  ...GitHubPublicationActionSchema.properties,
                }
              : {}),
            ...(refreshBaseAvailable ? GitHubBaseRefreshSchema.properties : {}),
            ...GitHubPublicationEditSchema.properties,
            ...(evidenceAvailable
              ? { evidence: Type.Optional(GitHubPublicationEvidenceSchema) }
              : {}),
            action: actionsAvailable
              ? Type.Optional(
                  Type.Union([
                    Type.Literal("publish"),
                    ...(refreshBaseAvailable ? [Type.Literal("refresh_base")] : []),
                    Type.Literal("edit"),
                    Type.Literal("request_review"),
                    ...(evidenceAvailable ? [Type.Literal("upload_evidence")] : []),
                    ...GitHubPublicationActionSchema.properties.action.anyOf,
                  ]),
                )
              : Type.Optional(
                  Type.Union([
                    ...(refreshBaseAvailable ? [Type.Literal("refresh_base")] : []),
                    Type.Literal("edit"),
                    Type.Literal("ready"),
                    Type.Literal("request_review"),
                    ...(evidenceAvailable ? [Type.Literal("upload_evidence")] : []),
                  ]),
                ),
            title: Type.Optional(GitHubPublicationTitleSchema),
            body: GitHubPublicationEditSchema.properties.body,
            draft: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        )
      : GitHubPublicationActionSchema,
    execute: async (toolCallId, rawArgs) => {
      // SAFETY: the tool runtime validates rawArgs against the closed schema above.
      const input = rawArgs as Omit<SessionGitHubPublishParams, "idempotencyKey" | "sessionKey"> &
        Omit<GitHubPublicationAction, "action"> &
        Omit<GitHubPublicationEdit, "action"> & {
          action?:
            | "publish"
            | "refresh_base"
            | "edit"
            | "request_review"
            | "upload_evidence"
            | GitHubPublicationAction["action"];
          evidence?: GitHubPublicationEvidence;
          conflictsResolved?: boolean;
          baseCommit?: string;
        };
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey) {
        throw new Error("GitHub publication requires the current Gateway session.");
      }
      if (input.draft !== undefined && input.action && input.action !== "publish") {
        throw new Error("draft only selects the state when publishing a new PR.");
      }
      if (input.action === "request_review") {
        if (
          !publicationAvailable ||
          Object.keys(input).some(
            (key) => !["action", "requestId", "expectedHeadCommit"].includes(key),
          )
        ) {
          throw new Error(
            "request_review only posts the fixed ClawSweeper command on the current session PR.",
          );
        }
        return jsonResult(
          await callGateway<SessionGitHubActionResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action: "request_review",
            requestId: input.requestId,
            expectedHeadCommit: input.expectedHeadCommit,
          }),
        );
      }
      if (input.action === "upload_evidence") {
        if (
          !input.evidence ||
          input.publishingSessionKey !== undefined ||
          input.mergeMethod !== undefined ||
          input.conflictsResolved !== undefined ||
          input.baseCommit !== undefined ||
          input.title !== undefined ||
          input.body !== undefined ||
          input.expectedTitle !== undefined ||
          input.expectedBody !== undefined
        ) {
          throw new Error(
            "upload_evidence accepts only this session's observed PR and inspected workspace media.",
          );
        }
        return jsonResult(
          await withGatewayToolCallerIdentity(
            { ...caller, workspaceEvidenceSandbox: options.sandbox ?? undefined },
            () =>
              callGateway<SessionGitHubActionResult>(
                "sessions.github.action",
                {
                  sessionKey: caller.sessionKey,
                  action: "upload_evidence",
                  requestId: input.requestId,
                  expectedHeadCommit: input.expectedHeadCommit,
                  evidence: input.evidence,
                },
                { timeoutMs: 180_000 },
              ),
          ),
        );
      }
      if (input.evidence !== undefined) {
        throw new Error(
          "Use upload_evidence for inspected media; other actions do not upload files.",
        );
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
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
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
        refreshBaseAvailable,
        evidenceAvailable,
      );
    },
  });
}

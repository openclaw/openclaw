import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../../packages/agent-core/src/tool-execution-context.js";
import {
  GitHubBaseRefreshSchema,
  GitHubPullRequestInspectSchema,
  type SessionGitHubPullRequestInspectResult,
  type SessionGitHubPullRequestPrepareResult,
  type SessionGitHubBaseRefreshResult,
  GitHubPublicationActionSchema,
  GitHubPublicationEditSchema,
  type GitHubPublicationEdit,
  GitHubPublicationEvidenceSchema,
  type GitHubPublicationEvidence,
  GitHubPublicationTitleSchema,
  SessionGitHubPullRequestInspectResultSchema,
  type GitHubPublicationAction,
  type SessionGitHubActionResult,
  type SessionGitHubReadinessResult,
  type SessionGitHubPublicationResult,
  type SessionGitHubPublishParams,
  SessionGitHubPublishParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { waitForGatewayDispatch } from "../../gateway/server-in-process-dispatch.js";
import { captureExecRequestOwners } from "../../infra/exec-request-context.js";
import { resolveReplyRunForCurrentSessionId } from "../../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import { bindAgentToolListingScope } from "../agent-tool-metadata.js";
import {
  canPrepareGitHubPullRequest,
  canRefreshGitHubPublicationBase,
  canUploadGitHubPublicationEvidence,
} from "../sandbox/github-publication.js";
import type { SandboxContext } from "../sandbox/types.js";
import { stringEnum } from "../schema/string-enum.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import type { AnyAgentTool } from "./common.js";
import {
  withGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import {
  describeGitHubPublishTool,
  githubActionGuidance,
  guidedResult,
} from "./github-publish-guidance.js";
import { callAgentToolGatewayRequest, callInProcessGatewayTool } from "./in-process-gateway.js";
import type { SessionsYieldCallback } from "./sessions-yield-tool.js";

const publicationOperatorActions = GitHubPublicationActionSchema.properties.action.anyOf.map(
  (action) => action.const,
);
const publicationWorkspaceActions = [
  "publish",
  "readiness",
  "inspect_pr",
  "create_issue",
  "create_comment",
  "prepare_pr",
  "refresh_base",
  "edit",
  "ready",
  "request_review",
  "upload_evidence",
];

const commentIssueNumber = Type.Optional(
  SessionGitHubPullRequestInspectResultSchema.properties.number,
);
const GITHUB_PUBLISH_TOOL_TIMEOUT_MS = 600_000;

export const githubPublishToolDefinition = {
  name: "github_publish",
  parameters: Type.Object(
    {
      publishingSessionKey: GitHubPublicationActionSchema.properties.publishingSessionKey,
      ...GitHubBaseRefreshSchema.properties,
      ...GitHubPublicationEditSchema.properties,
      evidence: Type.Optional(GitHubPublicationEvidenceSchema),
      action: Type.Optional(stringEnum(publicationWorkspaceActions)),
      title: Type.Optional(GitHubPublicationTitleSchema),
      body: GitHubPublicationEditSchema.properties.body,
      issueNumber: commentIssueNumber,
      draft: Type.Optional(Type.Boolean()),
      workspacePath: SessionGitHubPublishParamsSchema.properties.workspacePath,
    },
    { additionalProperties: false },
  ),
};

/** Describe the schema after policy filtering, without claiming prepared runtime capabilities. */
export function describeGitHubPublishToolPreview(parameters: unknown): string {
  const properties = isRecord(parameters) ? parameters.properties : undefined;
  const action = isRecord(properties) ? properties.action : undefined;
  if (!isRecord(action) || !Array.isArray(action.enum)) {
    throw new Error("GitHub tool preview requires a declared action enum.");
  }
  const actions = action.enum.filter((value): value is string => typeof value === "string");
  return `GitHub actions in this preview: ${actions.join(", ")}. Some actions depend on the prepared runtime; previewing them grants no execution authority.`;
}

// Tool construction runs every turn; one schema object per availability combination keeps
// identity-keyed schema normalization and prepared-descriptor caches warm.
const githubPublishParameterSchemas = new Map<string, AnyAgentTool["parameters"]>();
const githubPublicationObservationParameters = Type.Object(
  {
    action: stringEnum(["readiness"]),
    publishingSessionKey: GitHubPublicationActionSchema.properties.publishingSessionKey,
    requestId: GitHubPublicationActionSchema.properties.requestId,
  },
  { additionalProperties: false },
);

function resolveGitHubPublishParameters(params: {
  publicationAvailable: boolean;
  prepareAvailable: boolean;
  refreshBaseAvailable: boolean;
  evidenceAvailable: boolean;
  workspacePreparationAvailable: boolean;
  workspaceActions: readonly string[];
}): AnyAgentTool["parameters"] {
  const { publicationAvailable, refreshBaseAvailable, evidenceAvailable, workspaceActions } =
    params;
  // workspaceActions derives from the availability flags, so they fully key the schema.
  const key = [
    publicationAvailable,
    params.prepareAvailable,
    refreshBaseAvailable,
    evidenceAvailable,
    params.workspacePreparationAvailable,
  ].join(":");
  let schema = githubPublishParameterSchemas.get(key);
  if (!schema) {
    schema = publicationAvailable
      ? Type.Object(
          {
            ...GitHubPublicationActionSchema.properties,
            ...(refreshBaseAvailable ? GitHubBaseRefreshSchema.properties : {}),
            ...GitHubPublicationEditSchema.properties,
            ...(evidenceAvailable
              ? { evidence: Type.Optional(GitHubPublicationEvidenceSchema) }
              : {}),
            action: Type.Optional(
              stringEnum([...new Set([...workspaceActions, ...publicationOperatorActions])]),
            ),
            title: Type.Optional(GitHubPublicationTitleSchema),
            body: GitHubPublicationEditSchema.properties.body,
            issueNumber: commentIssueNumber,
            draft: Type.Optional(Type.Boolean()),
            ...(params.workspacePreparationAvailable
              ? { workspacePath: SessionGitHubPublishParamsSchema.properties.workspacePath }
              : {}),
          },
          { additionalProperties: false },
        )
      : Type.Object(
          {
            ...GitHubPublicationActionSchema.properties,
            pullRequestUrl: Type.Optional(GitHubPullRequestInspectSchema.properties.pullRequestUrl),
            action: stringEnum([
              "readiness",
              "inspect_pr",
              "create_issue",
              "create_comment",
              ...publicationOperatorActions,
            ]),
            title: Type.Optional(GitHubPublicationTitleSchema),
            body: SessionGitHubPublishParamsSchema.properties.body,
            issueNumber: commentIssueNumber,
          },
          { additionalProperties: false },
        );
    githubPublishParameterSchemas.set(key, schema);
  }
  return schema;
}

export function createGitHubPublishTool(
  options: {
    publicationAvailable?: boolean;
    /** Known absent writer configuration: retain credential-free receipt observation only. */
    observationOnly?: boolean;
    /** Inventory only: expose conditional action declarations without an execution path. */
    preview?: true;
    sandbox?: SandboxContext | null;
    sessionId?: string;
    runId?: string;
    onYield?: SessionsYieldCallback;
  } & Pick<
    SpawnedToolContext,
    "inheritedToolAllowlist" | "inheritedToolDenylist" | "sessionPermissionPolicy"
  > = {},
): AnyAgentTool {
  const publicationSupported = options.publicationAvailable !== false;
  const publicationAvailable = !options.observationOnly && publicationSupported;
  const workspacePreparationAvailable = !options.sandbox;
  const prepareSupported = options.preview || canPrepareGitHubPullRequest(options.sandbox);
  const prepareAvailable = !options.observationOnly && prepareSupported;
  // An unbound sandboxed conversation prepares by yielding and adopting a managed workspace.
  const adopting = prepareAvailable && options.sandbox?.workspaceSource !== "managed-worktree";
  const refreshBaseAvailable = options.preview || canRefreshGitHubPublicationBase(options.sandbox);
  const evidenceAvailable = options.preview || canUploadGitHubPublicationEvidence(options.sandbox);
  const workspaceActions = publicationWorkspaceActions.filter(
    (action) =>
      (action !== "prepare_pr" || prepareAvailable) &&
      (action !== "refresh_base" || refreshBaseAvailable) &&
      (action !== "upload_evidence" || evidenceAvailable),
  );
  let operation = options.runId ? findSessionControllerOperationByRunId(options.runId) : undefined;
  if (options.runId === undefined && options.sessionId) {
    const current = resolveReplyRunForCurrentSessionId(options.sessionId);
    operation = current.kind === "one" ? current.operation : undefined;
  }
  const requestOwners = captureExecRequestOwners(options);
  const tool: AnyAgentTool = {
    label: options.observationOnly ? "GitHub Publication Readiness" : "GitHub Publish",
    name: githubPublishToolDefinition.name,
    getExecutionTimeoutMs: (args) =>
      isRecord(args) && args.action === "create_comment"
        ? GITHUB_PUBLISH_TOOL_TIMEOUT_MS
        : undefined,
    // An unbound sandboxed preparation yields this turn. Like sessions_yield, it runs only as a
    // direct call: a Code Mode exec cannot carry a turn handoff. On-demand keeps every call
    // direct without sending this definition before the session first uses it.
    ...((prepareSupported && options.sandbox?.workspaceSource !== "managed-worktree") ||
    (publicationSupported && workspacePreparationAvailable)
      ? { async: false as const, catalogMode: "on-demand" as const }
      : {}),
    description: options.observationOnly
      ? "Observe GitHub publication readiness and existing receipts with action readiness; no authenticated actions are offered. Retain an accepted or uncertain requestId; never resubmit it. For GitHub setup, ask the operator to check Settings → Agents → Tools."
      : options.preview
        ? "Work with GitHub issues and pull requests through the Gateway."
        : describeGitHubPublishTool({
            publicationAvailable,
            prepareAvailable,
            refreshBaseAvailable,
            evidenceAvailable,
            workspacePreparationAvailable,
          }),
    parameters: options.observationOnly
      ? githubPublicationObservationParameters
      : resolveGitHubPublishParameters({
          publicationAvailable,
          prepareAvailable,
          refreshBaseAvailable,
          evidenceAvailable,
          workspacePreparationAvailable,
          workspaceActions,
        }),
    execute: async (toolCallId, rawArgs, signal) => {
      if (options.preview) {
        throw new Error("GitHub tool previews cannot execute actions.");
      }
      // SAFETY: the tool runtime validates rawArgs against the closed schema above.
      const input = rawArgs as Omit<SessionGitHubPublishParams, "idempotencyKey" | "sessionKey"> &
        Omit<GitHubPublicationAction, "action"> &
        Omit<GitHubPublicationEdit, "action"> & {
          action?:
            | "readiness"
            | "create_issue"
            | "create_comment"
            | "inspect_pr"
            | "prepare_pr"
            | "publish"
            | "refresh_base"
            | "edit"
            | "request_review"
            | "upload_evidence"
            | GitHubPublicationAction["action"];
          pullRequestUrl?: string;
          issueNumber?: number;
          evidence?: GitHubPublicationEvidence;
          conflictsResolved?: boolean;
          baseCommit?: string;
        };
      const action = input.action ?? "publish";
      if (options.observationOnly && action !== "readiness") {
        throw new Error(
          "Only publication readiness and existing receipt observation are available.",
        );
      }
      if (
        input.workspacePath !== undefined &&
        (action !== "publish" || !workspacePreparationAvailable)
      ) {
        throw new Error(
          action === "publish"
            ? "workspacePath is only available for local host publication."
            : `workspacePath is accepted only with action publish. Send only the fields ${action} needs; omit optional fields instead of filling them with placeholders.`,
        );
      }
      // The Gateway authorizes each action against the current caller; listing never grants it.
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey) {
        throw new Error("GitHub publication requires the current Gateway session.");
      }
      // Bound the response wait, including Code Mode callers. A timeout does not undo
      // accepted Gateway work; inspect its existing receipt before retrying.
      const callGateway: typeof callInProcessGatewayTool = (...args) =>
        waitForGatewayDispatch(
          args[0],
          callInProcessGatewayTool(...args),
          args[2]?.timeoutMs ?? GITHUB_PUBLISH_TOOL_TIMEOUT_MS,
          signal,
        );
      if (action === "readiness") {
        const extra = Object.keys(input).filter(
          (key) => !["action", "publishingSessionKey", "requestId"].includes(key),
        );
        if (extra.length) {
          throw new Error(
            `readiness accepts only publishingSessionKey and an existing requestId; remove ${extra.join(", ")}.`,
          );
        }
        const readiness = await callGateway<SessionGitHubReadinessResult>(
          "sessions.github.readiness",
          {
            sessionKey: input.publishingSessionKey ?? caller.sessionKey,
            ...(input.publishingSessionKey ? {} : { agentId: caller.agentId }),
            ...(input.requestId ? { requestId: input.requestId } : {}),
          },
        );
        // An unbound workspace is the normal starting state, not a failure; say how to proceed.
        return guidedResult(
          githubActionGuidance.readiness,
          readiness.custody.kind === "unbound_workspace" &&
            !input.publishingSessionKey &&
            publicationAvailable &&
            workspacePreparationAvailable
            ? {
                ...readiness,
                next: "No checkout is bound yet. Commit the work, then publish with workspacePath set to the checkout. Running background exec, unfinished children, open terminals or another active run refuse preparation; finish or kill them first.",
              }
            : readiness,
        );
      }
      const handoff = async (
        name: string,
        method: "sessions.github.action" | "sessions.github.publish",
        params: Record<string, unknown>,
      ) => {
        const { handoffSessionTool } = await import("./session-tool-handoff.js");
        return handoffSessionTool({
          name,
          sessionId: options.sessionId,
          runId: options.runId,
          operation,
          requestOwners,
          onYield: options.onYield,
          signal,
          ...(method === "sessions.github.action" || caller.operatorAuthority?.participationCeiling
            ? { retainRequester: true as const }
            : {}),
          fenceSuccessors: true,
          run: ({ assertCurrent, signal: handoffSignal }) =>
            withGatewayToolCallerIdentity(
              {
                agentId: caller.agentId,
                sessionKey: caller.sessionKey,
                workspaceBaseRefreshSandbox: options.sandbox ?? undefined,
                workspacePrAdoptionSessionId: options.sessionId,
                workspacePublicationRunId: options.runId,
                ...(method === "sessions.github.publish" &&
                (options.inheritedToolAllowlist ||
                  options.inheritedToolDenylist ||
                  options.sessionPermissionPolicy)
                  ? {
                      workspacePublicationPolicy: {
                        allow: [...(options.inheritedToolAllowlist ?? [])],
                        deny: [...(options.inheritedToolDenylist ?? [])],
                        permissionMode: options.sessionPermissionPolicy?.mode,
                      },
                    }
                  : {}),
              },
              () =>
                callAgentToolGatewayRequest({
                  method,
                  params,
                  sessionMutationCommitGuard: assertCurrent,
                  signal: handoffSignal,
                  timeoutMs: null,
                }),
            ),
          // Only PR import can return repository-sized path lists.
          formatResult: (result) =>
            method === "sessions.github.publish"
              ? JSON.stringify(
                  result.status === "failed"
                    ? result
                    : { ...result, next: githubActionGuidance.publish },
                )
              : JSON.stringify({
                  status: result.status,
                  url: result.url,
                  headCommit: result.headCommit,
                  headChanged: result.headChanged,
                  review: result.review,
                  ...(result.ok === false
                    ? {
                        ok: false,
                        error:
                          typeof result.error === "string"
                            ? truncateUtf16Safe(result.error, 1600)
                            : name + " failed.",
                      }
                    : {}),
                  next: githubActionGuidance.prepare_pr,
                }),
        });
      };
      if (input.draft !== undefined && input.action && input.action !== "publish") {
        throw new Error("draft only selects the state when publishing a new PR.");
      }
      if (input.action === "prepare_pr") {
        if (
          !publicationAvailable ||
          !input.pullRequestUrl ||
          Object.keys(input).some(
            (key) =>
              !["action", "pullRequestUrl", "conflictsResolved", "expectedHeadCommit"].includes(
                key,
              ),
          )
        ) {
          throw new Error(
            "prepare_pr accepts this PR's URL and its returned conflict acknowledgement for the current workspace.",
          );
        }
        const params = {
          sessionKey: caller.sessionKey,
          action: "prepare_pr" as const,
          pullRequestUrl: input.pullRequestUrl,
          ...(input.conflictsResolved !== undefined
            ? { conflictsResolved: input.conflictsResolved }
            : {}),
          ...(input.expectedHeadCommit ? { expectedHeadCommit: input.expectedHeadCommit } : {}),
        };
        if (adopting && options.sandbox) {
          return handoff("PR preparation", "sessions.github.action", params);
        }
        return guidedResult(
          githubActionGuidance.prepare_pr,
          await withGatewayToolCallerIdentity(
            { ...caller, workspaceBaseRefreshSandbox: options.sandbox ?? undefined },
            () =>
              callGateway<SessionGitHubPullRequestPrepareResult>("sessions.github.action", params, {
                timeoutMs: 600_000,
              }),
          ),
        );
      }
      if (input.action === "create_issue") {
        if (
          !input.title ||
          Object.keys(input).some((key) => !["action", "title", "body"].includes(key))
        ) {
          throw new Error(
            "create_issue accepts only a title and optional body for the current project.",
          );
        }
        return guidedResult(
          githubActionGuidance.create_issue,
          await callGateway("sessions.github.action", {
            action: "create_issue",
            sessionKey: caller.sessionKey,
            agentId: caller.agentId,
            title: input.title,
            ...(input.body !== undefined ? { body: input.body } : {}),
          }),
        );
      }
      if (input.action === "create_comment") {
        if (
          input.issueNumber === undefined ||
          !input.body ||
          Object.keys(input).some((key) => !["action", "issueNumber", "body"].includes(key))
        ) {
          throw new Error(
            "create_comment accepts only an issueNumber and body for the current project.",
          );
        }
        return guidedResult(
          githubActionGuidance.create_comment,
          await callGateway(
            "sessions.github.action",
            {
              action: "create_comment",
              sessionKey: caller.sessionKey,
              agentId: caller.agentId,
              issueNumber: input.issueNumber,
              body: input.body,
            },
            { signal },
          ),
        );
      }
      if (input.action === "inspect_pr") {
        const extra = Object.keys(input).filter(
          (key) => !["action", "pullRequestUrl"].includes(key),
        );
        if (!input.pullRequestUrl || extra.length) {
          throw new Error(
            `inspect_pr accepts only the pullRequestUrl to inspect, without publication or workspace fields${extra.length ? `; remove ${extra.join(", ")}` : ""}.`,
          );
        }
        return guidedResult(
          prepareAvailable
            ? `${githubActionGuidance.inspect_pr} ${githubActionGuidance.inspectPrPrepare}`
            : githubActionGuidance.inspect_pr,
          await callGateway<SessionGitHubPullRequestInspectResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action: "inspect_pr",
            pullRequestUrl: input.pullRequestUrl,
          }),
        );
      }
      if (
        input.pullRequestUrl !== undefined &&
        !["edit", "request_review", ...publicationOperatorActions].includes(action)
      ) {
        throw new Error(
          `Use inspect_pr${prepareAvailable ? " or prepare_pr" : ""}, edit, request_review, inspect, ready, merge or close for a pullRequestUrl.`,
        );
      }
      if (input.action === "request_review") {
        if (
          !publicationAvailable ||
          Object.keys(input).some(
            (key) => !["action", "pullRequestUrl", "requestId", "expectedHeadCommit"].includes(key),
          )
        ) {
          throw new Error(
            "request_review only posts the fixed ClawSweeper command on an authorized PR.",
          );
        }
        return guidedResult(
          githubActionGuidance.request_review,
          await callGateway<SessionGitHubActionResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action: "request_review",
            ...(input.pullRequestUrl !== undefined ? { pullRequestUrl: input.pullRequestUrl } : {}),
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
        return guidedResult(
          githubActionGuidance.upload_evidence,
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
          throw new Error(
            "edit accepts the current session PR or a verified PR URL, with metadata fields only.",
          );
        }
        return guidedResult(
          input.title === undefined && input.body === undefined
            ? githubActionGuidance.editRead
            : githubActionGuidance.edit,
          await callGateway<SessionGitHubActionResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action: "edit",
            ...(input.pullRequestUrl !== undefined ? { pullRequestUrl: input.pullRequestUrl } : {}),
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
      if (action === "refresh_base") {
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
        return guidedResult(
          githubActionGuidance.refresh_base,
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
      if (action !== "publish") {
        return guidedResult(
          action === "ready" || action === "inspect" || action === "merge" || action === "close"
            ? githubActionGuidance[action]
            : undefined,
          await callGateway<SessionGitHubActionResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action,
            ...(input.pullRequestUrl !== undefined ? { pullRequestUrl: input.pullRequestUrl } : {}),
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
      const publishParams: SessionGitHubPublishParams = {
        sessionKey: caller.sessionKey,
        idempotencyKey: assistantTurnId ? `${assistantTurnId}:${toolCallId}` : toolCallId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
        ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
      };
      if (input.workspacePath !== undefined || caller.operatorAuthority?.participationCeiling) {
        return handoff("GitHub publication", "sessions.github.publish", publishParams);
      }
      const result = await callGateway<SessionGitHubPublicationResult>(
        "sessions.github.publish",
        publishParams,
      );
      return guidedResult(
        result.status === "failed" ? undefined : githubActionGuidance.publish,
        result,
      );
    },
  };
  bindAgentToolListingScope(
    tool,
    [
      publicationSupported,
      prepareSupported,
      refreshBaseAvailable,
      evidenceAvailable,
      workspacePreparationAvailable,
    ].join(":"),
  );
  return tool;
}

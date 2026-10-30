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
  type GitHubPublicationAction,
  type SessionGitHubActionResult,
  type SessionGitHubReadinessResult,
  type SessionGitHubPublicationResult,
  type SessionGitHubPublishParams,
  SessionGitHubPublishParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { captureExecRequestOwners } from "../../infra/exec-request-context.js";
import { resolveReplyRunForCurrentSessionId } from "../../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import {
  canPrepareGitHubPullRequest,
  canRefreshGitHubPublicationBase,
  canUploadGitHubPublicationEvidence,
} from "../sandbox/github-publication.js";
import type { SandboxContext } from "../sandbox/types.js";
import { stringEnum } from "../schema/string-enum.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import {
  withGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayTool as callGateway,
} from "./in-process-gateway.js";
import type { SessionsYieldCallback } from "./sessions-yield-tool.js";

const publicationOperatorActions = GitHubPublicationActionSchema.properties.action.anyOf.map(
  (action) => action.const,
);
const publicationWorkspaceActions = [
  "publish",
  "readiness",
  "inspect_pr",
  "prepare_pr",
  "refresh_base",
  "edit",
  "ready",
  "request_review",
  "upload_evidence",
];

export const githubPublishToolDefinition = {
  name: "github_publish",
  parameters: Type.Object(
    {
      publishingSessionKey: GitHubPublicationActionSchema.properties.publishingSessionKey,
      pullRequestUrl: Type.Optional(GitHubPullRequestInspectSchema.properties.pullRequestUrl),
      ...GitHubBaseRefreshSchema.properties,
      ...GitHubPublicationEditSchema.properties,
      evidence: Type.Optional(GitHubPublicationEvidenceSchema),
      action: Type.Optional(stringEnum(publicationWorkspaceActions)),
      title: Type.Optional(GitHubPublicationTitleSchema),
      body: GitHubPublicationEditSchema.properties.body,
      draft: Type.Optional(Type.Boolean()),
      workspacePath: SessionGitHubPublishParamsSchema.properties.workspacePath,
    },
    { additionalProperties: false },
  ),
};

function describeGitHubPublishTool(
  publicationAvailable: boolean,
  prepareAvailable: boolean,
  refreshBaseAvailable: boolean,
  evidenceAvailable: boolean,
): string {
  const continuation =
    'continue that work before ending the turn, or use automations to schedule a continuation when it offers add and the current caller is authorized (at + agentTurn + sessionTarget "session:<this session key from Runtime>"). While that scheduled continuation waits, use automations next_check to rearm its existing job, not add another job. If a scheduled continuation is unavailable, explain the remaining work';
  const readiness =
    "readiness: strictly observe the selected publishing session and optional existing requestId without credentials, refresh, source adoption, publication or recovery. Reports separate read policy, custody, bounded target support and shared receipt facts; write authority, authentication, exact remote destination, CI and mergeability remain unknown. A cwd is not a publication binding. Select an existing bound session, or separately authorize supported binding/adoption; observation never performs it. Pending or unconfirmed effects retain their original requestId: observe that request, never resubmit it. Accepts only action, publishingSessionKey and requestId. ";
  const inspection =
    "inspect_pr: supply pullRequestUrl to read an existing PR authored by your currently verified linked GitHub account. Accepts copied PR tab, query and comment links. Returns the canonical PR URL, author, state, base/head repositories, branches and observed commits. It does not prepare a workspace, bind the PR, publish changes or grant later authority. This is not a credential preflight for the managed publisher: bot-authored PRs need not belong to your linked account. Private repositories require verified current account access. ";
  const publication = publicationAvailable
    ? `Publish or edit the current session's PR through Gateway-held credentials, for local or cloud repository workspaces.
- publish (default when action is omitted): publish accepted workspace changes as an open PR by default; draft: true creates a draft. title/body and draft are used only when creating a PR. Updating an existing PR preserves its state. requested/publishing means accepted, not finished: retain requestId, finish the turn and await its result here; do not submit another publication to recover it. The receipt does not resume the agent. If authorized review, CI or landing remains, ${continuation}; a receipt does not complete it.
- edit: read current metadata with {action: "edit"}, omitting expectedHeadCommit, title/body and expectedTitle/expectedBody. To change either field, send the read's top-level headCommit as expectedHeadCommit (not publication.headCommit), requestId when a publication receipt is returned, and its new value with the observed expectedTitle/expectedBody. Keep attribution, marker and footer unchanged in the full body. Omitted fields stay unchanged. Edit never synchronizes, stages, commits or pushes files or changes PR state. After an uncertain response, read again with only {action: "edit"} before retrying.
- ready: mark the current session's own draft ready for review, using the expectedHeadCommit and any publication requestId observed with edit. After an uncertain response, read with edit before retrying. This does not merge the PR.
- request_review: after an explicit re-review request, read the current PR with edit, then send expectedHeadCommit and any publication requestId to post only "@clawsweeper re-review". No comment text, focus or child target is accepted. Posting is not review acceptance or completion. If the response is uncertain, read existing PR comments before any new request; never retry blindly.
${prepareAvailable ? `- prepare_pr: when the user asks to continue their own existing PR, supply pullRequestUrl. Intent may be established before the URL arrives; inspect_pr is optional. An ordinary unbound conversation yields and resumes here with a new owned PR workspace. Earlier files remain in their original source and earlier message links stay read-only. Background work, children or terminals cause a no-effect busy refusal; finish or observe them and retry. Initial preparation in an already managed workspace requires clean source without dirty, untracked, staged, or unpublished work; otherwise preparation preserves it and refuses. For a PR this conversation published, including one the managed publisher authored, preparation instead merges another writer's newer head into the saved work. A clean workspace receives exactly the PR head files. Already managed workspaces keep their directory, sandbox scope and guest Git history. Preparation associates the original PR without publishing. Repeating a completed same-head preparation preserves edits without resetting files. ${refreshBaseAvailable ? "An explicit refresh reconciles the PR's current destination and review comparison while preserving local edits and history; a destination change alone does not merge it into the PR head. Use inspect_pr for current branch and commit facts when needed. Reconcile recoverable changes from the user's intent; ask a focused question only when the intended work is materially ambiguous. Do not ask the user to undo a destination change. An explicit refresh of the bound PR integrates its newer head while preserving later guest work. Files with both staged and unstaged changes must have their staged changes committed first; refresh preserves them and refuses. Resolve returned conflictPaths, then repeat with conflictsResolved: true and expectedHeadCommit set to the returned headCommit. " : ""}Interrupted preparation finishes the same accepted head; if headChanged is true, repeat to integrate the newer remote head. Tests and Auto Review use the returned exact review base. After preparation, omit action to append accepted changes to the original PR through the shared publisher, preserving its branch history, author and draft state. A remote head change refuses publication and preserves local work until the newer head is integrated; do not create a replacement PR. Existing edit, ready${evidenceAvailable ? ", upload_evidence" : ""} and request_review actions use the original bound PR before any new push. Read with edit first: an imported target returns pullRequest instead of a publication receipt; send expectedHeadCommit without requestId.\n` : ""}${evidenceAvailable ? "- upload_evidence: upload one inspected image/video from this conversation's sandbox workspace to its existing GitHub.com PR repository. First read the PR with edit; send its expectedHeadCommit, any publication requestId, and evidence {path: workspace-relative path, sha256: inspected lowercase SHA-256, sizeBytes: inspected byte count, at most 10 MB}. Supports PNG, JPEG, GIF, WebP, MP4, MOV and WebM. Only the inspected bytes are sent. Use the returned uploaded URL with edit to associate it in the PR body, then verify reviewer access; uploaded does not prove public access. An unconfirmed result may have created an attachment: never repeat the upload blindly. No host credentials, other mounts, remote URLs, repository or PR selectors are accepted.\n" : ""}${refreshBaseAvailable ? "- refresh_base: integrate the selected base into this local managed sandbox before tests and Auto Review. Resolve returned conflicts, then acknowledge with conflictsResolved: true and the returned baseCommit, including unchanged binary choices. Tests and Auto Review use the returned exact review base (mode local). Refresh stages source but preserves guest HEAD/branches/commits and never publishes.\n" : ""}Edit${evidenceAvailable ? ", upload_evidence" : ""}, request_review${refreshBaseAvailable ? ", refresh_base" : ""} and own-draft readiness accept no other repository, PR, ref or publishing session.`
    : "This conversation cannot publish its own workspace. It can act on an explicitly selected publishing child's PR.";
  return `${readiness}${inspection}${publication} For an explicit landing request from a person with full operator write access, use inspect, then ready and merge after review and required checks. For an explicit closure request, use close to close the PR without merging or deleting saved work. ready, merge and close require the inspected expectedHeadCommit and any publication requestId; merge also requires mergeMethod. For delegated work, explicitly select its publishingSessionKey from this conversation's children; never guess a PR. Actions return the observed GitHub state and never enable auto-merge. Inspect after an uncertain response before retrying. Inspect, merge, close and child selection require full operator write access. These actions also support a bound original PR: use its observed expectedHeadCommit without requestId when no publication receipt is returned. Actions do not change session sandboxing.`;
}

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
            pullRequestUrl: Type.Optional(GitHubPullRequestInspectSchema.properties.pullRequestUrl),
            ...GitHubPublicationEditSchema.properties,
            ...(evidenceAvailable
              ? { evidence: Type.Optional(GitHubPublicationEvidenceSchema) }
              : {}),
            action: Type.Optional(
              stringEnum([...new Set([...workspaceActions, ...publicationOperatorActions])]),
            ),
            title: Type.Optional(GitHubPublicationTitleSchema),
            body: GitHubPublicationEditSchema.properties.body,
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
            action: stringEnum(["readiness", "inspect_pr", ...publicationOperatorActions]),
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
    /** Inventory only: expose conditional action declarations without an execution path. */
    preview?: true;
    sandbox?: SandboxContext | null;
    sessionId?: string;
    runId?: string;
    onYield?: SessionsYieldCallback;
    senderIsOwner?: boolean;
  } = {},
): AnyAgentTool {
  const publicationAvailable = options.publicationAvailable !== false;
  const workspacePreparationAvailable = !options.sandbox;
  const prepareAvailable = options.preview || canPrepareGitHubPullRequest(options.sandbox);
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
    label: "GitHub Publish",
    name: githubPublishToolDefinition.name,
    // An unbound sandboxed preparation yields this turn. Like sessions_yield, it stays a direct
    // call: a Code Mode exec cannot carry a turn handoff.
    ...(adopting || (publicationAvailable && workspacePreparationAvailable)
      ? { async: false as const, catalogMode: "direct-only" as const }
      : {}),
    description: options.preview
      ? "Work with GitHub pull requests through the Gateway."
      : describeGitHubPublishTool(
          publicationAvailable,
          prepareAvailable,
          refreshBaseAvailable,
          evidenceAvailable,
        ),
    parameters: resolveGitHubPublishParameters({
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
            | "inspect_pr"
            | "prepare_pr"
            | "publish"
            | "refresh_base"
            | "edit"
            | "request_review"
            | "upload_evidence"
            | GitHubPublicationAction["action"];
          pullRequestUrl?: string;
          evidence?: GitHubPublicationEvidence;
          conflictsResolved?: boolean;
          baseCommit?: string;
        };
      const action = input.action ?? "publish";
      if (
        input.workspacePath !== undefined &&
        (action !== "publish" || !workspacePreparationAvailable)
      ) {
        throw new Error("workspacePath is only available for local host publication.");
      }
      // The Gateway authorizes each action against the current caller; listing never grants it.
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey) {
        throw new Error("GitHub publication requires the current Gateway session.");
      }
      if (action === "readiness") {
        if (
          Object.keys(input).some(
            (key) => !["action", "publishingSessionKey", "requestId"].includes(key),
          )
        ) {
          throw new Error("readiness accepts only publishingSessionKey and an existing requestId.");
        }
        return jsonResult(
          await callGateway<SessionGitHubReadinessResult>("sessions.github.readiness", {
            sessionKey: input.publishingSessionKey ?? caller.sessionKey,
            ...(input.publishingSessionKey ? {} : { agentId: caller.agentId }),
            ...(input.requestId ? { requestId: input.requestId } : {}),
          }),
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
          senderIsOwner: options.senderIsOwner,
          fenceSuccessors: true,
          run: ({ assertCurrent, signal: handoffSignal }) =>
            withGatewayToolCallerIdentity(
              {
                agentId: caller.agentId,
                sessionKey: caller.sessionKey,
                workspaceBaseRefreshSandbox: options.sandbox ?? undefined,
                workspacePrAdoptionSessionId: options.sessionId,
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
              ? JSON.stringify(result)
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
        return jsonResult(
          await withGatewayToolCallerIdentity(
            { ...caller, workspaceBaseRefreshSandbox: options.sandbox ?? undefined },
            () =>
              callGateway<SessionGitHubPullRequestPrepareResult>("sessions.github.action", params, {
                timeoutMs: 600_000,
              }),
          ),
        );
      }
      if (input.action === "inspect_pr") {
        if (
          !input.pullRequestUrl ||
          Object.keys(input).some((key) => !["action", "pullRequestUrl"].includes(key))
        ) {
          throw new Error(
            "inspect_pr accepts only the pullRequestUrl to inspect, without publication or workspace fields.",
          );
        }
        return jsonResult(
          await callGateway<SessionGitHubPullRequestInspectResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action: "inspect_pr",
            pullRequestUrl: input.pullRequestUrl,
          }),
        );
      }
      if (input.pullRequestUrl !== undefined) {
        throw new Error(
          `Use inspect_pr${prepareAvailable ? " or prepare_pr" : ""} for a pullRequestUrl; other actions keep their session-bound target.`,
        );
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
      if (action !== "publish") {
        return jsonResult(
          await callGateway<SessionGitHubActionResult>("sessions.github.action", {
            sessionKey: caller.sessionKey,
            action,
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
      if (input.workspacePath !== undefined) {
        return handoff("GitHub publication", "sessions.github.publish", publishParams);
      }
      const result = await callGateway<SessionGitHubPublicationResult>(
        "sessions.github.publish",
        publishParams,
      );
      return jsonResult(result);
    },
  };
  return tool;
}

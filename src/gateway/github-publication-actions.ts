import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionGitHubActionParams,
  SessionGitHubActionResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { redactToolDetail } from "../logging/redact.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { preparePublishingSession, pullRequestState } from "./github-publication-action-target.js";
import {
  assertExpectedSharedGitHubPublisher,
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
} from "./github-publication-availability.js";
import { uploadGitHubPublicationEvidence } from "./github-publication-evidence.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import { inspectOwnGitHubPullRequest } from "./github-publication-inspect.js";
import { assertExistingPullRequestWriteAccess } from "./github-publication-pr-preflight.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type Options = Omit<GatewayRequestHandlerOptions, "params"> & {
  params: Exclude<
    SessionGitHubActionParams,
    { action: "refresh_base" | "inspect_pr" | "prepare_pr" }
  >;
};
function assertPreservedPublicationFooter(before: string, after: string) {
  const marker = before.indexOf("\n\n<!-- openclaw-publication:");
  const credit = before.indexOf("\n\n## Worked on by\n\n");
  // Preserve the whole original suffix; added lookalike blocks cannot replace its identity.
  const start = marker < 0 ? credit : credit < 0 ? marker : Math.min(marker, credit);
  if (start >= 0 && !after.includes(before.slice(start))) {
    throw new Error("Keep the existing PR attribution, publication marker and footer unchanged.");
  }
}

/** Execute one explicit operation against the session's bound original PR or shared publication. */
export async function performSessionGitHubAction(options: Options): Promise<void> {
  const { params, context } = options;
  const caller = getGatewayToolCallerIdentity();
  if (
    caller &&
    (params.sessionKey !== caller.sessionKey ||
      (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
  ) {
    throw new Error("GitHub action session does not match the current conversation.");
  }
  const edit = params.action === "edit" ? params : undefined;
  const evidenceUpload = params.action === "upload_evidence" ? params : undefined;
  const requestReview = params.action === "request_review";
  const ownPublicationAction = Boolean(edit || requestReview || evidenceUpload);
  const editsMetadata = edit && (edit.title !== undefined || edit.body !== undefined);
  if (
    edit &&
    ((edit.title !== undefined) !== (edit.expectedTitle !== undefined) ||
      (edit.body !== undefined) !== (edit.expectedBody !== undefined))
  ) {
    throw new Error(
      "Supply the observed expectedTitle or expectedBody for each field being edited.",
    );
  }
  if (params.action !== "inspect" && (!edit || editsMetadata) && !params.expectedHeadCommit) {
    throw new Error(
      "Read the current PR with edit or inspect, then supply its expectedHeadCommit and publication requestId when present.",
    );
  }
  if (params.action === "merge" && !params.mergeMethod) {
    throw new Error("Select the repository's intended mergeMethod before merging.");
  }
  const service = context.githubPublicationService;
  if (!service) {
    throw new Error("GitHub publication is unavailable on this Gateway.");
  }
  using resources = new DisposableStack();
  const target = await preparePublishingSession(
    { ...params, agentId: caller?.agentId ?? params.agentId },
    () => options.sessionMutationAuthorization?.assertCurrent(),
    resources,
  );
  const loaded = target.selected.readCurrent();
  const entry = loaded.entry!;
  const session = {
    sessionKey: loaded.canonicalKey,
    sessionId: entry.sessionId,
    agentId: loaded.agentId,
    lifecycleRevision: entry.lifecycleRevision ?? null,
  };
  const admitted = await prepareGitHubPublicationRequesterV2(options, session);
  resources.defer(admitted.release);
  const assertRequester = () => {
    target.assertCurrent();
    admitted.requester.assertCurrent();
    if (
      !ownPublicationAction &&
      !(params.action === "ready" && params.publishingSessionKey === undefined) &&
      !roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: admitted.requester.snapshot.scopes,
      })
    ) {
      throw new Error("GitHub pull request actions require full operator write permission.");
    }
  };
  assertRequester();
  const binding = entry.worktree?.githubPullRequest;
  const receipt = binding
    ? undefined
    : ownPublicationAction
      ? await service.latestPublishedShared(session, () => target.selected.readCurrent())
      : await service.latestShared(session, undefined, undefined, () =>
          target.selected.readCurrent(),
        );
  assertRequester();
  const publication = receipt?.result.status === "published" ? receipt.result : undefined;
  if (!binding && !publication) {
    throw new Error(
      edit
        ? "This session has no completed shared publication to edit."
        : "This session has no completed shared publication. For delegated work, select its publishingSessionKey explicitly.",
    );
  }
  if (binding && params.requestId) {
    throw new Error(
      "This PR is selected by its workspace association. Read it again and use expectedHeadCommit without a publication requestId.",
    );
  }
  if (
    publication &&
    ((params.action !== "inspect" && (!edit || editsMetadata) && !params.requestId) ||
      (params.requestId && params.requestId !== publication.requestId) ||
      (params.expectedHeadCommit && params.expectedHeadCommit !== publication.headCommit))
  ) {
    throw new Error(
      "The publication changed; inspect the current PR and review its head before retrying.",
    );
  }
  const pullRequest = binding
    ? { url: binding.url, repository: binding.base.repository, branch: binding.head.branch }
    : publication!;
  const identity = await prepareCurrentGitHubPublicationIdentity(session.agentId);
  assertRequester();
  if (publication) {
    assertExpectedSharedGitHubPublisher(publication.publisher, {
      source: identity.source,
      ...identity.account,
    });
  }
  const fullWrite = roleScopesAllow({
    role: "operator",
    requestedScopes: ["operator.write"],
    allowedScopes: admitted.requester.snapshot.scopes,
  });
  let inspection: Awaited<ReturnType<typeof inspectOwnGitHubPullRequest>> | undefined;
  const assertIdentity = () => {
    assertRequester();
    if (!matchesCurrentGitHubPublicationIdentity({ agentId: session.agentId, identity })) {
      throw new Error(
        "The GitHub publisher changed; inspect the current identity before retrying.",
      );
    }
  };
  const assertCurrent = () => {
    assertIdentity();
    inspection?.assertCurrent();
  };
  const url = URL.parse(pullRequest.url);
  const host = identity.host ?? "github.com";
  const expectedPath = `/${pullRequest.repository}/pull/`;
  const number = url?.pathname.slice(expectedPath.length);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.host !== host ||
    (binding && binding.host !== host) ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(expectedPath) ||
    !number ||
    !/^[1-9][0-9]*$/u.test(number) ||
    url.search ||
    url.hash
  ) {
    throw new Error("The publication's GitHub target is invalid.");
  }
  const endpoint = `repos/${pullRequest.repository}/pulls/${number}`;
  const read = async () => {
    assertCurrent();
    if (binding && !fullWrite) {
      inspection = await inspectOwnGitHubPullRequest({
        pullRequestUrl: binding.url,
        agentId: session.agentId,
        requester: admitted.requester,
        assertCurrent: assertIdentity,
      });
    }
    const result = await runPublicationCommand(githubPublicationApiArgs(endpoint, "GET", host), {
      env: identity.env,
      beforeRun: assertCurrent,
    });
    assertCurrent();
    if (result.code !== 0) {
      throw new Error(
        "GitHub PR state is unavailable; check the publisher's repository access and retry inspect.",
      );
    }
    return pullRequestState(
      JSON.parse(result.stdout.toString("utf8")),
      pullRequest,
      binding,
      inspection?.result.author.accountId,
    );
  };
  const present = (
    state: ReturnType<typeof pullRequestState>,
    extra?: Pick<SessionGitHubActionResult, "reviewRequest" | "evidence">,
  ): void => {
    const { nodeId: _, title, body, ...facts } = state;
    const result: SessionGitHubActionResult = {
      ...(publication ? { publication } : { pullRequest }),
      publishingSessionKey: session.sessionKey,
      ...facts,
      ...(edit ? { title, body } : {}),
      ...extra,
    };
    assertCurrent();
    options.respond(true, result);
  };
  let before = await read();
  if (params.action === "inspect" || (edit && !editsMetadata)) {
    return present(before);
  }
  const assertHead = (state: ReturnType<typeof pullRequestState>, detail = "") => {
    if (state.headCommit !== params.expectedHeadCommit) {
      throw new Error(
        `The GitHub PR head changed; inspect and review the new publication before retrying. A previous action may already have completed.${detail}`,
      );
    }
  };
  assertHead(before);
  const prepareImportedEffect = async () => {
    if (inspection) {
      const current = await assertExistingPullRequestWriteAccess({
        pullRequest: inspection.result,
        identity,
        assertCurrent,
      });
      assertCurrent();
      return pullRequestState(current, pullRequest, binding, inspection.result.author.accountId);
    }
    assertCurrent();
    return null;
  };
  if (evidenceUpload) {
    const assertOpen = (state: ReturnType<typeof pullRequestState>) => {
      assertHead(state);
      if (state.state === "closed" || state.state === "merged") {
        throw new Error("Evidence can be uploaded only for this session's open PR.");
      }
    };
    assertOpen(before);
    const evidence = await uploadGitHubPublicationEvidence({
      evidence: evidenceUpload.evidence,
      sandbox: caller?.workspaceEvidenceSandbox,
      sessionKey: session.sessionKey,
      repository: pullRequest.repository,
      identity,
      signal: admitted.requester.signal,
      assertCurrent,
      prepareEffect: async () => {
        if (publication) {
          const current = await service.latestPublishedShared(session, () =>
            target.selected.readCurrent(),
          );
          assertCurrent();
          if (
            current?.result.status !== "published" ||
            current.result.requestId !== publication.requestId ||
            current.result.headCommit !== publication.headCommit ||
            current.result.url !== publication.url
          ) {
            throw new Error(
              "The publication changed; read the current PR before uploading evidence.",
            );
          }
        }
        assertOpen(await read());
        await prepareImportedEffect();
        assertCurrent();
      },
    });
    return present(before, { evidence });
  }
  const metadataMatches = (state: ReturnType<typeof pullRequestState>) =>
    edit &&
    (edit.title === undefined || state.title === edit.title) &&
    (edit.body === undefined || state.body === edit.body);
  if (edit) {
    if (metadataMatches(before)) {
      return present(before);
    }
    const current = await prepareImportedEffect();
    if (current) {
      before = current;
      assertHead(before);
      if (metadataMatches(before)) {
        return present(before);
      }
    }
    if (
      (edit.title !== undefined &&
        before.title !== edit.title &&
        before.title !== edit.expectedTitle) ||
      (edit.body !== undefined && before.body !== edit.body && before.body !== edit.expectedBody)
    ) {
      throw new Error(
        "The PR metadata changed; read it with edit and reconcile the requested changes before retrying.",
      );
    }
    if (edit.body !== undefined) {
      assertPreservedPublicationFooter(before.body, edit.body);
    }
    if (before.state === "merged" || before.state === "closed") {
      throw new Error("The published PR is closed; its metadata and saved work are unchanged.");
    }
  }
  if (requestReview && (before.state === "merged" || before.state === "closed")) {
    throw new Error("The published PR is closed; no re-review request was posted.");
  }
  if (
    before.state === "merged" ||
    (params.action === "ready" && before.state === "open") ||
    (params.action === "close" && before.state === "closed")
  ) {
    return present(before);
  }
  if (before.state === "closed") {
    throw new Error("The published PR is closed without merging; saved work is unchanged.");
  }
  if (params.action === "merge" && before.state === "draft") {
    throw new Error("Mark the reviewed draft ready before requesting merge.");
  }
  if (
    params.action === "merge" &&
    (before.mergeable !== true || !["clean", "unstable", "has_hooks"].includes(before.mergeState))
  ) {
    throw new Error(
      "GitHub does not report this PR ready to merge; inspect its required reviews, checks and conflicts before retrying.",
    );
  }
  const attribution =
    params.action === "merge" && params.mergeMethod === "squash"
      ? await prepareGitCoauthorAttribution({
          ...session,
          config: currentGitHubPublicationConfig(),
          storePath: loaded.storePath,
          excludeAccountId: identity.account.accountId,
        })
      : undefined;
  assertCurrent();
  if (binding && attribution) {
    const current = await read();
    assertHead(current);
    if (
      current.state !== before.state ||
      current.title !== before.title ||
      current.body !== before.body ||
      current.mergeable !== before.mergeable ||
      current.mergeState !== before.mergeState
    ) {
      throw new Error(
        "The original PR changed during merge preparation; inspect it again before merging.",
      );
    }
  }
  if (!edit) {
    await prepareImportedEffect();
  }
  const assertEffect = () => {
    assertCurrent();
    if (attribution && !attribution.isCurrent()) {
      throw new Error(
        "GitHub contributor credit changed; inspect the publication before retrying.",
      );
    }
  };
  // The transport never retries writes. Lifecycle state can be reread; a lost comment response stays uncertain.
  let commandResult: string;
  let reviewCommentUrl: string | undefined;
  const reviewCommand = "@clawsweeper re-review";
  try {
    const result = await runPublicationCommand(
      githubPublicationApiArgs(
        requestReview
          ? `repos/${pullRequest.repository}/issues/${number}/comments`
          : params.action === "ready"
            ? "graphql"
            : params.action === "close" || edit
              ? endpoint
              : `${endpoint}/merge`,
        requestReview || params.action === "ready"
          ? "POST"
          : params.action === "close" || edit
            ? "PATCH"
            : "PUT",
        host,
      ),
      {
        env: identity.env,
        beforeRun: assertEffect,
        input: JSON.stringify(
          requestReview
            ? { body: reviewCommand }
            : params.action === "ready"
              ? {
                  query:
                    "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }",
                  variables: { id: before.nodeId },
                }
              : edit
                ? {
                    ...(edit.title !== undefined ? { title: edit.title } : {}),
                    ...(edit.body !== undefined ? { body: edit.body } : {}),
                  }
                : params.action === "close"
                  ? { state: "closed" }
                  : {
                      sha: params.expectedHeadCommit,
                      merge_method: params.action === "merge" ? params.mergeMethod : undefined,
                      ...(params.action === "merge" && params.mergeMethod === "squash"
                        ? { commit_title: before.title }
                        : {}),
                      ...(attribution?.attribution?.trailers.length
                        ? { commit_message: attribution.attribution.trailers.join("\n") }
                        : {}),
                    },
        ),
      },
    );
    if (requestReview && result.code === 0) {
      const comment: unknown = JSON.parse(result.stdout.toString("utf8"));
      if (
        isRecord(comment) &&
        typeof comment.id === "number" &&
        Number.isSafeInteger(comment.id) &&
        comment.id > 0 &&
        comment.body === reviewCommand &&
        isRecord(comment.user) &&
        comment.user.id === identity.account.accountId &&
        comment.html_url === `${pullRequest.url}#issuecomment-${comment.id}`
      ) {
        reviewCommentUrl = comment.html_url;
      }
    }
    commandResult = [
      `gh api ${result.code === null ? result.termination : `exit ${result.code}`}`,
      result.stderr.toString("utf8").trim(),
      result.stdout.toString("utf8").trim(),
      result.error?.message,
    ]
      .filter(Boolean)
      .join(": ");
  } catch (error) {
    assertEffect();
    commandResult = error instanceof Error ? error.message : String(error);
  }
  // Redact the complete diagnostic before truncating, so a cut cannot expose part of a secret.
  const failureDetail = commandResult
    ? ` Command result: ${redactToolDetail(commandResult).slice(0, 2000)}`
    : "";
  if (requestReview) {
    if (reviewCommentUrl) {
      return present(before, {
        reviewRequest: {
          status: "posted",
          url: reviewCommentUrl,
          message:
            "ClawSweeper re-review request posted; review acceptance and completion are not confirmed.",
        },
      });
    }
    throw new Error(
      `GitHub has not confirmed the re-review comment; it may already have been posted. Read the PR comments before another request; do not retry blindly.${failureDetail}`,
    );
  }
  const after = await read().catch((error: unknown) => {
    assertCurrent();
    if (failureDetail && error instanceof Error) {
      throw new Error(`${error.message}${failureDetail}`);
    }
    throw error;
  });
  assertHead(after, failureDetail);
  if (edit) {
    if (metadataMatches(after)) {
      return present(after);
    }
    throw new Error(
      `GitHub has not confirmed the metadata edit; read the PR with edit before retrying. Saved work is unchanged.${failureDetail}`,
    );
  }
  if (
    after.state === "merged" ||
    (params.action === "ready" && after.state === "open") ||
    (params.action === "close" && after.state === "closed")
  ) {
    return present(after);
  }
  if (params.action === "close") {
    throw new Error(
      `GitHub has not confirmed close; inspect the PR state and repository permissions before retrying. Saved work is unchanged.${failureDetail}`,
    );
  }
  throw new Error(
    `GitHub has not confirmed ${params.action}; inspect the PR's required reviews, checks, conflicts and repository permissions before retrying. Saved work is unchanged.${failureDetail}`,
  );
}

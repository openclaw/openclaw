import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionGitHubActionParams,
  SessionGitHubActionResult,
  SessionGitHubPublicationPublished,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  assertExpectedSharedGitHubPublisher,
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type Options = Omit<GatewayRequestHandlerOptions, "params"> & {
  params: SessionGitHubActionParams;
};
type SessionRead = Awaited<ReturnType<typeof prepareGitHubPublicationSession>>;

/** Keep every selected parent alive; a reparented child cannot redirect a retained action. */
async function preparePublishingSession(
  params: SessionGitHubActionParams,
  assertCurrent: () => void,
  resources: DisposableStack,
) {
  const source = resources.use(
    await prepareGitHubPublicationSession(params.sessionKey, {
      agentId: params.agentId,
      assertCurrent,
    }),
  );
  const selected =
    params.publishingSessionKey && params.publishingSessionKey !== source.loaded.canonicalKey
      ? resources.use(
          await prepareGitHubPublicationSession(params.publishingSessionKey, { assertCurrent }),
        )
      : source;
  const readers: SessionRead[] = [source, selected];
  const assertSessions = () => {
    assertCurrent();
    for (const reader of readers) {
      if (!reader.readCurrent().entry?.sessionId) {
        throw new Error("The GitHub publication session is unavailable.");
      }
    }
  };
  let key = selected.loaded.canonicalKey;
  let agentId = selected.loaded.agentId;
  const seen = new Set<string>();
  while (key !== source.loaded.canonicalKey || agentId !== source.loaded.agentId) {
    const identity = `${agentId}\0${key}`;
    if (seen.has(identity) || seen.size >= 64) {
      throw new Error("The publishing session is not a child of this conversation.");
    }
    seen.add(identity);
    const lineage = resources.use(
      await prepareGitHubPublicationSession(key, {
        agentId: parseAgentSessionKey(key) ? undefined : agentId,
        assertCurrent,
        fields: ["sessionId", "lifecycleRevision", "parentSessionKey", "spawnedBy"],
      }),
    );
    readers.push(lineage);
    assertSessions();
    agentId = lineage.loaded.agentId;
    if (
      lineage.loaded.canonicalKey === source.loaded.canonicalKey &&
      agentId === source.loaded.agentId
    ) {
      break;
    }
    const entry = lineage.readCurrent().entry;
    const parent = entry?.parentSessionKey ?? entry?.spawnedBy;
    if (!parent) {
      throw new Error("The publishing session is not a child of this conversation.");
    }
    key = parent;
  }
  assertSessions();
  return { selected, assertCurrent: assertSessions };
}

function pullRequestState(value: unknown, publication: SessionGitHubPublicationPublished) {
  if (
    !isRecord(value) ||
    !isRecord(value.head) ||
    !isRecord(value.base) ||
    !isRecord(value.base.repo) ||
    typeof value.node_id !== "string" ||
    !value.node_id ||
    value.html_url !== publication.url ||
    value.head.ref !== publication.branch ||
    typeof value.base.repo.full_name !== "string" ||
    value.base.repo.full_name.toLowerCase() !== publication.repository.toLowerCase() ||
    typeof value.head.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.head.sha) ||
    (value.state !== "open" && value.state !== "closed") ||
    typeof value.draft !== "boolean" ||
    typeof value.merged !== "boolean" ||
    (value.mergeable !== null && typeof value.mergeable !== "boolean") ||
    typeof value.mergeable_state !== "string" ||
    (value.merge_commit_sha !== null && typeof value.merge_commit_sha !== "string")
  ) {
    throw new Error(
      "GitHub returned an invalid pull request state; inspect the published PR before retrying.",
    );
  }
  return {
    nodeId: value.node_id,
    state: value.merged
      ? ("merged" as const)
      : value.state === "closed"
        ? ("closed" as const)
        : value.draft
          ? ("draft" as const)
          : ("open" as const),
    headCommit: value.head.sha,
    // Open PRs can expose a synthetic test-merge SHA, not a landed commit.
    mergeCommit: value.merged ? value.merge_commit_sha : null,
    mergeable: value.mergeable,
    mergeState: value.mergeable_state,
  };
}

/** Execute one explicit operation against the session's recorded shared publication. */
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
  if (params.action !== "inspect" && (!params.requestId || !params.expectedHeadCommit)) {
    throw new Error(
      "Inspect the published PR first, then supply its requestId and expectedHeadCommit.",
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
  const receipt = await service.latestShared(session, undefined, undefined, () =>
    target.selected.readCurrent(),
  );
  assertRequester();
  if (receipt?.result.status !== "published") {
    throw new Error(
      "This session has no completed shared publication. For delegated work, select its publishingSessionKey explicitly.",
    );
  }
  const publication = receipt.result;
  if (
    (params.requestId && params.requestId !== publication.requestId) ||
    (params.expectedHeadCommit && params.expectedHeadCommit !== publication.headCommit)
  ) {
    throw new Error(
      "The publication changed; inspect the current PR and review its head before retrying.",
    );
  }
  const identity = await prepareCurrentGitHubPublicationIdentity(session.agentId);
  assertRequester();
  assertExpectedSharedGitHubPublisher(publication.publisher, {
    source: identity.source,
    ...identity.account,
  });
  const assertCurrent = () => {
    assertRequester();
    if (!matchesCurrentGitHubPublicationIdentity({ agentId: session.agentId, identity })) {
      throw new Error(
        "The GitHub publisher changed; inspect the current identity before retrying.",
      );
    }
  };
  const url = URL.parse(publication.url);
  const host = identity.host ?? "github.com";
  const expectedPath = `/${publication.repository}/pull/`;
  const number = url?.pathname.slice(expectedPath.length);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.host !== host ||
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
  const endpoint = `repos/${publication.repository}/pulls/${number}`;
  const read = async () => {
    assertCurrent();
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
    return pullRequestState(JSON.parse(result.stdout.toString("utf8")), publication);
  };
  const present = (state: ReturnType<typeof pullRequestState>): void => {
    const { nodeId: _, ...facts } = state;
    const result: SessionGitHubActionResult = {
      publication,
      publishingSessionKey: session.sessionKey,
      ...facts,
    };
    assertCurrent();
    options.respond(true, result);
  };
  const before = await read();
  if (params.action === "inspect") {
    return present(before);
  }
  const assertHead = (state: ReturnType<typeof pullRequestState>) => {
    if (state.headCommit !== params.expectedHeadCommit) {
      throw new Error(
        "The GitHub PR head changed; inspect and review the new publication before retrying. A previous action may already have completed.",
      );
    }
  };
  assertHead(before);
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
  const assertEffect = () => {
    assertCurrent();
    if (attribution && !attribution.isCurrent()) {
      throw new Error(
        "GitHub contributor credit changed; inspect the publication before retrying.",
      );
    }
  };
  // The transport makes no write retry. Re-read the original target even after a lost response.
  try {
    await runPublicationCommand(
      githubPublicationApiArgs(
        params.action === "ready"
          ? "graphql"
          : params.action === "close"
            ? endpoint
            : `${endpoint}/merge`,
        params.action === "ready" ? "POST" : params.action === "close" ? "PATCH" : "PUT",
        host,
      ),
      {
        env: identity.env,
        beforeRun: assertEffect,
        input: JSON.stringify(
          params.action === "ready"
            ? {
                query:
                  "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }",
                variables: { id: before.nodeId },
              }
            : params.action === "close"
              ? { state: "closed" }
              : {
                  sha: params.expectedHeadCommit,
                  merge_method: params.mergeMethod,
                  ...(attribution?.attribution?.trailers.length
                    ? { commit_message: attribution.attribution.trailers.join("\n") }
                    : {}),
                },
        ),
      },
    );
  } catch {
    assertEffect();
  }
  const after = await read();
  assertHead(after);
  if (
    after.state === "merged" ||
    (params.action === "ready" && after.state === "open") ||
    (params.action === "close" && after.state === "closed")
  ) {
    return present(after);
  }
  if (params.action === "close") {
    throw new Error(
      "GitHub has not confirmed close; inspect the PR state and repository permissions before retrying. Saved work is unchanged.",
    );
  }
  throw new Error(
    `GitHub has not confirmed ${params.action}; inspect the PR's required reviews, checks, conflicts and repository permissions before retrying. Saved work is unchanged.`,
  );
}

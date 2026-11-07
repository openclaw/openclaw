import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import { githubRepositoryUrl } from "../agents/github-host.js";
import { readNativeGitHubToken } from "../agents/github-read-identity.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { prepareGitHubPublicationContent } from "./github-publication-content.js";
import {
  createGitHubPublicationExecutionIdentity,
  type GitHubPublicationIdentityOwner,
} from "./github-publication-execution-identity.js";
import {
  GitHubPublicationBranchChangedError,
  GitHubPublicationCreditChangedError,
  GitHubPublicationKnownFailure,
  GitHubPublicationRequesterUnavailableError,
  GitHubPublicationWorkspaceChangedError,
  recordGitHubPublicationFailure,
} from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  githubPublicationApiArgs,
  gitHubPublicationObjectSha as objectSha,
  hasGitHubPublicationMessageFooter,
  requirePublicationCommand,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import {
  findGitHubPublicationPullRequest,
  readPublishedGitHubPullRequest,
  type PublishedGitHubPullRequest,
} from "./github-publication-pull-requests.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { readRepositoryGitHubPublicationInputAsync } from "./github-publication-store-async.js";
import type { RepositoryGitHubPublicationExecutionAsync } from "./github-publication-store-async.js";
import {
  hasRepositoryGitHubPublicationWorkflowChanges,
  hasUniqueGitHubPublicationWorkflowAncestor,
  prepareGitHubPublicationWorkflowGuard,
} from "./github-publication-workflows.js";
import {
  readGitHubRepositoryPublicationBlob,
  type GitHubRepositoryPublicationSnapshot,
} from "./github-repository-publication-snapshot.js";
import { GatewayOperatorAccessUnavailableError } from "./operator-access-policy.js";
import type { PrepareRepositoryPublicationIntegration } from "./repository-publication-integration.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import type { RepositoryGitHistory } from "./worker-environments/session-repository-checkpoints.types.js";

async function api(
  endpoint: string,
  identity: PreparedGitHubPublicationIdentity,
  assertCurrent: () => void,
  body?: unknown,
): Promise<unknown> {
  assertCurrent();
  const raw = await requirePublicationCommand(
    githubPublicationApiArgs(
      endpoint,
      body === undefined ? "GET" : "POST",
      identity.host ?? resolveGitHubHost(),
    ),
    {
      env: identity.env,
      beforeRun: assertCurrent,
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
    },
  );
  assertCurrent();
  return JSON.parse(raw);
}

/** GitHub receives only accepted normalized objects; the Gateway never fetches source history. */
export async function executeRepositoryGitHubPublication(params: {
  execution: RepositoryGitHubPublicationExecutionAsync;
  snapshot: GitHubRepositoryPublicationSnapshot;
  snapshotRoot: string;
  history?: RepositoryGitHistory;
  readDispatchCredential?: GitHubCredentialReader;
  prepareIntegration?: PrepareRepositoryPublicationIntegration;
  requesterProfileId?: string;
  storePath: string;
  assertWorkspace: () => void;
  readCurrentEntry: () => InternalSessionEntry | undefined;
  validateAuthority: () => boolean;
  assertWorkflowChangesAllowed: () => void;
  identity?: GitHubPublicationIdentityOwner;
}) {
  const { execution, snapshot } = params;
  const row = execution.row;
  const { assertCurrent, refreshIdentity } = createGitHubPublicationExecutionIdentity({
    row,
    identity: params.identity,
    assertWorkspace: params.assertWorkspace,
    validateAuthority: () => params.validateAuthority() && execution.ownsExecution(),
  });
  let dispatched = row.last_effect !== null;
  let integration: Awaited<ReturnType<PrepareRepositoryPublicationIntegration>> | undefined;
  try {
    assertCurrent();
    const { push_repository: pushRepository, repository, base_branch: baseBranch, branch } = row;
    if (
      !pushRepository ||
      !repository ||
      !baseBranch ||
      snapshot.baseCommit !== row.source_head_commit ||
      snapshot.baseTree !== row.source_index_tree ||
      snapshot.workspaceTree !== row.workspace_tree
    ) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication accepted checkpoint changed.",
      );
    }
    let identity = await refreshIdentity();
    const endpoint = "repos/" + pushRepository + "/git/";
    const sourceRepository = await api("repos/" + pushRepository, identity, assertCurrent);
    if (
      !isRecord(sourceRepository) ||
      typeof sourceRepository.node_id !== "string" ||
      !sourceRepository.node_id
    ) {
      throw new Error("GitHub publication repository identity is unavailable.");
    }
    const base = await api(endpoint + "commits/" + snapshot.baseCommit, identity, assertCurrent);
    if (
      !isRecord(base) ||
      objectSha(base.tree) !== snapshot.baseTree ||
      objectSha(base) !== snapshot.baseCommit
    ) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication pinned repository base changed.",
      );
    }
    const baseRef = await api(
      "repos/" + repository + "/git/ref/heads/" + encodeURIComponent(baseBranch),
      identity,
      assertCurrent,
    );
    if (!isRecord(baseRef) || baseRef.ref !== "refs/heads/" + baseBranch) {
      throw new Error("GitHub publication workspace base branch could not be verified.");
    }
    const remoteBase = objectSha(baseRef.object);
    const readMergeBase = async (source: string, target = remoteBase) => {
      const lineage = await requirePublicationCommand(
        [
          ...githubPublicationApiArgs(
            "repos/" + repository + "/compare/" + source + "..." + target + "?per_page=1",
            "GET",
            identity.host ?? resolveGitHubHost(),
          ),
          "--jq",
          "{sha: .merge_base_commit.sha}",
        ],
        { env: identity.env, beforeRun: assertCurrent },
      );
      assertCurrent();
      return objectSha(JSON.parse(lineage));
    };
    // A requested topic/tag/commit may be ahead of or diverged from the PR base.
    // GitHub's merge-base proves shared history without changing the accepted source.
    const mergeBase = await readMergeBase(snapshot.baseCommit);
    const hasUniqueWorkflowAncestor = (sourceCommit: string, ancestor: string) =>
      hasUniqueGitHubPublicationWorkflowAncestor({
        sourceCommit,
        ancestor,
        readMergeBase,
        readPage: async (page) => {
          const raw = await requirePublicationCommand(
            [
              ...githubPublicationApiArgs(
                "repos/" +
                  repository +
                  "/compare/" +
                  remoteBase +
                  "..." +
                  sourceCommit +
                  "?per_page=100&page=" +
                  page,
                "GET",
                identity.host ?? resolveGitHubHost(),
              ),
              "--jq",
              "{total_commits, commits: [.commits[] | {sha, parents: [.parents[] | {sha}]}]}",
            ],
            { env: identity.env, beforeRun: assertCurrent },
          );
          assertCurrent();
          return JSON.parse(raw) as unknown;
        },
      });
    let headCommit = row.head_commit;
    let managedInput: RepositoryGitHubPublicationRow | undefined;
    let preparedCommitMessage: string | undefined;
    const verifyCommit = (value: unknown, published?: RepositoryGitHubPublicationRow) => {
      const tree = isRecord(value) ? objectSha(value.tree) : undefined;
      if (
        !isRecord(value) ||
        !Array.isArray(value.parents) ||
        (published
          ? objectSha(value) !== published.pushed_head_commit
          : tree !== snapshot.workspaceTree ||
            value.parents.length !== 1 ||
            objectSha(value.parents[0]) !== (row.previous_head_commit ?? snapshot.baseCommit)) ||
        typeof value.message !== "string" ||
        !value.message
          .split(/\r?\n/u)
          .includes("OpenClaw-Publication: " + (published?.request_id ?? row.request_id))
      ) {
        throw new GitHubPublicationWorkspaceChangedError(
          "GitHub publication commit does not match its accepted checkpoint.",
        );
      }
      // The matched receipt binds this immutable head to the saved checkpoint. Its merge tree
      // also contains upstream changes, so it need not equal the original input tree.
      managedInput = published;
      preparedCommitMessage = value.message;
      return objectSha(value);
    };
    if (headCommit) {
      const current = await api(endpoint + "commits/" + headCommit, identity, assertCurrent);
      if (isRecord(current) && Array.isArray(current.parents) && current.parents.length === 2) {
        const accepted = await api(
          endpoint + "commits/" + objectSha(current.parents[0]),
          identity,
          assertCurrent,
        );
        const published =
          isRecord(accepted) &&
          typeof accepted.message === "string" &&
          !accepted.message.split(/\r?\n/u).includes("OpenClaw-Publication: " + row.request_id)
            ? await readRepositoryGitHubPublicationInputAsync(row, objectSha(accepted))
            : undefined;
        verifyCommit(accepted, published);
        // The execution receipt pins this immutable merge; its first parent proves accepted input.
        if (
          objectSha(current) !== headCommit ||
          typeof current.message !== "string" ||
          !current.message.split(/\r?\n/u).includes("OpenClaw-Publication: " + row.request_id)
        ) {
          throw new GitHubPublicationWorkspaceChangedError(
            "GitHub publication integrated commit changed.",
          );
        }
        preparedCommitMessage = current.message;
      } else if (verifyCommit(current) !== headCommit) {
        throw new Error("GitHub publication commit identity changed.");
      }
    }
    const observeHead = async () => {
      const observedIdentity = await refreshIdentity();
      const raw = await requirePublicationCommand(
        githubPublicationApiArgs(
          endpoint + "matching-refs/heads/" + encodeURIComponent(branch),
          "GET",
          observedIdentity.host ?? resolveGitHubHost(),
        ),
        { env: observedIdentity.env },
      );
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) {
        throw new Error("GitHub branch observation was invalid.");
      }
      const ref = value.find((entry) => isRecord(entry) && entry.ref === "refs/heads/" + branch);
      const observed = isRecord(ref) ? objectSha(ref.object) : null;
      // Preserve an authenticated response to a lost push before checking whether
      // its admission closed during the read. This records no permission to act.
      if (headCommit && observed === headCommit) {
        await execution.recordEffect("push", { headCommit });
      }
      assertCurrent();
      return observed;
    };
    let remoteHead = await observeHead();
    if (!headCommit && remoteHead !== null && remoteHead !== row.previous_head_commit) {
      const published = await readRepositoryGitHubPublicationInputAsync(row, remoteHead);
      if (published) {
        const current = await api(endpoint + "commits/" + remoteHead, identity, assertCurrent);
        if (verifyCommit(current, published) !== remoteHead) {
          throw new GitHubPublicationBranchChangedError();
        }
      }
    }
    if (
      remoteHead !== row.previous_head_commit &&
      remoteHead !== managedInput?.pushed_head_commit &&
      (!headCommit || remoteHead !== headCommit)
    ) {
      throw new GitHubPublicationBranchChangedError();
    }
    let publishedPullRequest: PublishedGitHubPullRequest | undefined;
    if (managedInput) {
      const host = identity.host ?? resolveGitHubHost();
      const url = URL.parse(managedInput.pull_request_url!);
      const number = Number(url?.pathname.split("/").at(-1));
      if (
        !url ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        url.href.toLowerCase() !== `https://${host}/${repository}/pull/${number}`.toLowerCase()
      ) {
        throw new GitHubPublicationBranchChangedError();
      }
      publishedPullRequest = { url: url.href, number, pushRepository };
      const { candidate } = await readPublishedGitHubPullRequest({
        publishedPullRequest,
        repository,
        branch,
        baseBranch,
        publisherAccountId: managedInput.identity_account_id,
        host,
        refreshIdentity,
        assertCurrent,
      });
      if (candidate.state !== "open" || candidate.headSha !== remoteHead) {
        throw new GitHubPublicationBranchChangedError();
      }
    }
    // Initial PR changes use GitHub's merge-base. Later checkpoints compare with
    // the preceding pushed tree, so restoring the PR base remains a real revert.
    const comparisonCommit = row.previous_head_commit ?? mergeBase;
    const comparisonRepository = row.previous_head_commit ? pushRepository : repository;
    const comparison =
      comparisonRepository === pushRepository && comparisonCommit === snapshot.baseCommit
        ? base
        : await api(
            "repos/" + comparisonRepository + "/git/commits/" + comparisonCommit,
            identity,
            assertCurrent,
          );
    if (!isRecord(comparison) || objectSha(comparison) !== comparisonCommit) {
      throw new Error("GitHub publication comparison commit changed.");
    }
    if (snapshot.workspaceTree === objectSha(comparison.tree)) {
      throw new GitHubPublicationKnownFailure("GitHub publication has no changes to publish.", {
        code: "no_changes",
        nextAction: "Make or restore a repository change, then retry.",
      });
    }
    const pushOwner = pushRepository.split("/")[0]!;
    const marker = "<!-- openclaw-publication:" + row.request_id + " -->";
    const findPullRequest = () =>
      findGitHubPublicationPullRequest({
        repository,
        pushOwner,
        branch,
        baseBranch,
        headCommit: headCommit ?? snapshot.baseCommit,
        marker,
        publishedPullRequest,
        host: identity.host ?? resolveGitHubHost(),
        refreshIdentity,
        assertCurrent,
        recordObserved:
          managedInput && !headCommit
            ? undefined
            : (url) => execution.recordEffect("pull_request", { url }),
      });
    await findPullRequest();
    const assertWorkflowAuthority = await prepareGitHubPublicationWorkflowGuard(
      params.assertWorkflowChangesAllowed,
      () =>
        hasRepositoryGitHubPublicationWorkflowChanges({
          snapshot,
          sourceRepository: pushRepository,
          comparisonRepository,
          comparisonTree: objectSha(comparison.tree),
          readUpstream: async () => {
            const sourceCommit = row.previous_head_commit ?? snapshot.baseCommit;
            const ancestor =
              sourceCommit === snapshot.baseCommit ? mergeBase : await readMergeBase(sourceCommit);
            // Prove the history of the same published/source commit whose
            // definition the guard compares, not a potentially older snapshot base.
            if (
              ancestor !== sourceCommit &&
              ancestor !== remoteBase &&
              !(await hasUniqueWorkflowAncestor(sourceCommit, ancestor))
            ) {
              return undefined;
            }
            if (
              sourceCommit !== snapshot.baseCommit &&
              mergeBase !== snapshot.baseCommit &&
              mergeBase !== remoteBase &&
              !(await hasUniqueWorkflowAncestor(snapshot.baseCommit, mergeBase))
            ) {
              return undefined;
            }
            const readTreeSha = async (commit: string) => {
              const value = await api(
                "repos/" + repository + "/git/commits/" + commit,
                identity,
                assertCurrent,
              );
              if (!isRecord(value) || objectSha(value) !== commit) {
                throw new Error("GitHub publication workflow commit changed.");
              }
              return objectSha(value.tree);
            };
            const [ancestorTree, targetTree] = await Promise.all([
              readTreeSha(ancestor),
              readTreeSha(remoteBase),
            ]);
            const sourceAncestorTree =
              mergeBase === ancestor
                ? ancestorTree
                : mergeBase === remoteBase
                  ? targetTree
                  : await readTreeSha(mergeBase);
            return { repository, ancestorTree, sourceAncestorTree, targetTree };
          },
          readTree: (owner, sha) =>
            api("repos/" + owner + "/git/trees/" + sha, identity, assertCurrent),
        }),
    );
    const assertPublicationAction = () => {
      assertWorkflowAuthority();
      assertCurrent();
    };
    assertPublicationAction();
    const content = await prepareGitHubPublicationContent({
      row,
      requesterProfileId: params.requesterProfileId,
      storePath: params.storePath,
      accountId: identity.account.accountId,
      host: identity.host ?? resolveGitHubHost(),
      assertCurrent: assertPublicationAction,
      readCurrentEntry: params.readCurrentEntry,
      description:
        row.body?.trim() || "Published by the Gateway from the accepted repository checkpoint.",
    });
    const { assertAction } = content;
    assertAction();
    if (
      headCommit &&
      remoteHead !== headCommit &&
      !hasGitHubPublicationMessageFooter(
        preparedCommitMessage ?? "",
        content.trailers,
        "OpenClaw-Publication: " + row.request_id,
      )
    ) {
      throw new GitHubPublicationCreditChangedError();
    }
    if (!headCommit) {
      if (!params.prepareIntegration) {
        throw new GitHubPublicationRecoveryPendingError(
          "Publication is waiting for its worker integration owner; retry the same request after worker recovery.",
        );
      }
      identity = await refreshIdentity();
      const token = await readNativeGitHubToken(
        identity.env,
        true,
        identity.host ?? resolveGitHubHost(),
      );
      assertAction();
      if (!token || !row.checkpoint_digest) {
        throw new Error("GitHub publication integration identity is unavailable.");
      }
      integration = await params.prepareIntegration(
        { sessionId: row.session_id, sessionKey: row.session_key, agentId: row.agent_id },
        {
          snapshotRoot: params.snapshotRoot,
          snapshotDigest: row.checkpoint_digest,
          history: params.history,
          sourceUrl: githubRepositoryUrl(pushRepository, identity.host ?? resolveGitHubHost()),
          targetUrl: githubRepositoryUrl(repository, identity.host ?? resolveGitHubHost()),
          targetCommit: remoteBase,
          token,
          readNativeCredential: params.readDispatchCredential,
          assertCurrent: assertAction,
        },
      );
      assertAction();
      const blobRoots = new Map<string, string>();
      for (const selected of [
        { snapshot, root: params.snapshotRoot },
        { snapshot: integration.snapshot, root: integration.snapshotRoot },
      ]) {
        for (const entry of selected.snapshot.entries) {
          if (entry.sha !== null && entry.mode !== "160000") {
            blobRoots.set(entry.sha, selected.root);
          }
        }
      }
      const shas = [...blobRoots.keys()];
      identity = await refreshIdentity();
      const uploaded = await runTasksWithConcurrency({
        limit: 4,
        errorMode: "stop",
        tasks: shas.map((sha) => async () => {
          assertCurrent();
          const bytes = await readGitHubRepositoryPublicationBlob(blobRoots.get(sha)!, sha);
          assertCurrent();
          const blob = await api(endpoint + "blobs", identity, assertAction, {
            content: bytes.toString("base64"),
            encoding: "base64",
          });
          if (objectSha(blob) !== sha) {
            throw new Error("GitHub publication blob content changed.");
          }
        }),
      });
      if (uploaded.hasError) {
        throw uploaded.firstError;
      }
      const createTree = async (value: GitHubRepositoryPublicationSnapshot) => {
        const tree =
          value.entries.length === 0
            ? value.baseTree
            : objectSha(
                await api(endpoint + "trees", identity, assertAction, {
                  base_tree: value.baseTree,
                  tree: value.entries.map((entry) => ({
                    ...entry,
                    type: entry.mode === "160000" ? "commit" : "blob",
                  })),
                }),
              );
        if (tree !== value.workspaceTree) {
          throw new GitHubPublicationWorkspaceChangedError(
            "GitHub publication normalized tree changed.",
          );
        }
        return tree;
      };
      const author = {
        name: identity.account.login,
        email:
          identity.account.accountId + "+" + identity.account.login + "@users.noreply.github.com",
        date: new Date(row.created_at_ms).toISOString(),
      };
      const accepted =
        managedInput?.pushed_head_commit ??
        verifyCommit(
          await api(endpoint + "commits", identity, assertAction, {
            tree: await createTree(snapshot),
            parents: [row.previous_head_commit ?? snapshot.baseCommit],
            author,
            committer: author,
            message: content.commitMessage,
          }),
        );
      const tree = await createTree(integration.snapshot);
      const merged = await api(endpoint + "commits", identity, assertAction, {
        tree,
        parents: [accepted, remoteBase],
        author,
        committer: author,
        message: content.commitMessage,
      });
      if (
        !isRecord(merged) ||
        objectSha(merged.tree) !== tree ||
        !Array.isArray(merged.parents) ||
        merged.parents.length !== 2 ||
        objectSha(merged.parents[0]) !== accepted ||
        objectSha(merged.parents[1]) !== remoteBase
      ) {
        throw new Error("GitHub publication integrated commit changed.");
      }
      headCommit = objectSha(merged);
      await execution.updateHead(headCommit);
    }
    if (remoteHead !== headCommit) {
      identity = await refreshIdentity();
      assertAction();
      await execution.recordEffect("push");
      dispatched = true;
      // GraphQL's beforeOid is an exact lease; REST's non-force update only checks ancestry.
      const result = await runPublicationCommand(
        githubPublicationApiArgs("graphql", "POST", identity.host ?? resolveGitHubHost()),
        {
          env: identity.env,
          beforeRun: assertAction,
          input: JSON.stringify({
            query:
              "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
            variables: {
              input: {
                repositoryId: sourceRepository.node_id,
                clientMutationId: row.request_id,
                refUpdates: [
                  {
                    name: "refs/heads/" + branch,
                    beforeOid: remoteHead ?? "0".repeat(40),
                    afterOid: headCommit,
                    force: false,
                  },
                ],
              },
            },
          }),
        },
      );
      let succeeded = false;
      if (result.code === 0) {
        const reply: unknown = JSON.parse(result.stdout.toString("utf8"));
        succeeded =
          isRecord(reply) &&
          !reply.errors &&
          isRecord(reply.data) &&
          isRecord(reply.data.updateRefs) &&
          reply.data.updateRefs.clientMutationId === row.request_id;
      }
      await execution.recordEffect("push", succeeded ? { headCommit } : {});
      assertCurrent();
      remoteHead = await observeHead();
      if (remoteHead !== headCommit) {
        throw new Error("GitHub push verification failed.");
      }
    }
    let url = await findPullRequest();
    if (!url) {
      identity = await refreshIdentity();
      assertAction();
      await execution.recordEffect("pull_request");
      dispatched = true;
      const created = await runPublicationCommand(
        githubPublicationApiArgs(
          `repos/${repository}/pulls`,
          "POST",
          identity.host ?? resolveGitHubHost(),
        ),
        {
          env: identity.env,
          beforeRun: assertAction,
          input: () =>
            JSON.stringify({
              title: content.title,
              body: content.pullRequestBody(),
              head: pushOwner + ":" + branch,
              base: baseBranch,
              // Requests accepted before the choice was introduced created drafts.
              draft: row.draft !== 0,
            }),
        },
      );
      if (created.code === 0) {
        const value: unknown = JSON.parse(created.stdout.toString("utf8"));
        if (isRecord(value) && typeof value.html_url === "string") {
          url = value.html_url;
        }
      }
      await execution.recordEffect("pull_request", url ? { url } : {});
      if (!url) {
        assertCurrent();
        url = await findPullRequest();
      }
    }
    if (!url) {
      throw new Error("GitHub pull request creation was rejected.");
    }
    return projectGitHubPublicationResult(
      await execution.complete({
        requestId: row.request_id,
        status: "published",
        url,
        repository,
        branch,
        headCommit,
      }),
    );
  } catch (error) {
    if (
      error instanceof GitHubPublicationRequesterUnavailableError ||
      error instanceof GatewayOperatorAccessUnavailableError ||
      error instanceof GitHubPublicationRecoveryPendingError
    ) {
      throw error;
    }
    if (dispatched && !(error instanceof GitHubPublicationKnownFailure)) {
      const interrupted = await execution.interrupt();
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      return projectGitHubPublicationResult(interrupted);
    }
    const failure = recordGitHubPublicationFailure(error, row);
    return projectGitHubPublicationResult(
      await execution.complete({
        requestId: row.request_id,
        status: "failed",
        ...failure,
        message: "GitHub publication failed.",
      }),
    );
  } finally {
    await integration?.release();
  }
}

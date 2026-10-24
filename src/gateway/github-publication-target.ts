import type { SessionGitHubPullRequestInspectResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import {
  prepareGitHubPublicationRepositoryIdentity,
  type readGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import {
  GitHubPublicationRequesterUnavailableError,
  GitHubPublicationBranchChangedError,
  GitHubPublicationWorkspaceChangedError,
} from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  requirePublicationCommand,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import { inspectOwnGitHubPullRequest } from "./github-publication-inspect.js";
import { assertExistingPullRequestWriteAccess } from "./github-publication-pr-preflight.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { resolveGitHubRepositoryTarget } from "./github-repository-target.js";

/** A refreshed observation must still name the bound PR and its original repositories/refs. */
function assertBoundGitHubPullRequest(
  binding: SessionGitHubPullRequestBinding,
  current: SessionGitHubPullRequestInspectResult,
): void {
  if (
    current.url !== binding.url ||
    current.host !== binding.host ||
    current.number !== binding.number ||
    !current.head ||
    current.base.repository !== binding.base.repository ||
    current.base.repositoryId !== binding.base.repositoryId ||
    current.base.branch !== binding.base.branch ||
    current.head.repository !== binding.head.repository ||
    current.head.repositoryId !== binding.head.repositoryId ||
    current.head.branch !== binding.head.branch
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "The original PR target changed; saved work was preserved.",
    );
  }
}

/** Resolve the authoritative Git remote and GitHub PR parent with the selected publisher. */
export async function prepareGitHubPublicationTarget(params: {
  worktree: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>["worktree"];
  identity: PreparedGitHubPublicationIdentity;
  pullRequest?: SessionGitHubPullRequestBinding;
  assertCurrent: () => void;
}) {
  const { worktree, assertCurrent } = params;
  const githubHost = params.identity.host ?? resolveGitHubHost();
  const repositoryIdentity = await prepareGitHubPublicationRepositoryIdentity(params);
  if (params.pullRequest) {
    const pr = params.pullRequest;
    if (
      pr.host !== githubHost ||
      !pr.preparedHeadCommit ||
      pr.preparedHeadCommit !== pr.head.commit
    ) {
      throw new GitHubPublicationWorkspaceChangedError(
        "The original PR preparation is incomplete or its publisher host changed.",
      );
    }
    const localBranch = await requirePublicationCommand(
      ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: worktree.path },
    );
    assertCurrent();
    if (localBranch !== worktree.branch) {
      throw new GitHubPublicationWorkspaceChangedError("GitHub publication branch changed.");
    }
    return {
      pushRepository: pr.head.repository,
      repository: pr.base.repository,
      branch: pr.head.branch,
      baseBranch: pr.base.branch,
      pushOwner: pr.head.repository.split("/")[0]!,
      githubHost,
    };
  }
  const remote = parseGitHubRemoteUrl(repositoryIdentity.originUrl, githubHost);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    throw new Error("GitHub publication requires a GitHub remote.");
  }
  const pushRepository = `${remote.owner}/${remote.repo}`;
  const branch = await requirePublicationCommand(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: worktree.path },
  );
  assertCurrent();
  if (branch !== worktree.branch) {
    throw new GitHubPublicationWorkspaceChangedError("GitHub publication branch changed.");
  }
  const raw = await requirePublicationCommand(
    [
      "gh",
      "api",
      "--hostname",
      githubHost,
      `repos/${pushRepository}`,
      "--jq",
      "{fork, default_branch, parent: {name: .parent.name, default_branch: .parent.default_branch, owner: {login: .parent.owner.login}}}",
    ],
    { env: params.identity.env },
  );
  assertCurrent();
  const value: unknown = JSON.parse(raw);
  const target = resolveGitHubRepositoryTarget(value, remote);
  if (!target) {
    throw new Error("GitHub repository response omitted its publication target.");
  }
  const repository = `${target.pullRequest.owner}/${target.pullRequest.repo}`;
  const baseBranch = target.fork
    ? target.pullRequest.defaultBranch
    : parseGitHubPublicationBaseBranch(worktree.baseRef, target.pullRequest.defaultBranch);
  if (!target.fork && branch === baseBranch) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication branch changed to its pull request base.",
    );
  }
  return {
    pushRepository,
    repository,
    branch,
    baseBranch,
    pushOwner: target.push.owner,
    githubHost,
  };
}

/** Reuse genuine publication receipts for repeats; a remote advance is never an implicit import. */
export async function prepareBoundGitHubPublication(params: {
  pullRequest: SessionGitHubPullRequestBinding;
  row: GitHubPublicationExecutionRow;
  cwd: string;
  requester: GitHubPublicationRequesterPolicyV2;
  refreshIdentity: () => Promise<PreparedGitHubPublicationIdentity>;
  assertCurrent: () => void;
}) {
  const { pullRequest: binding, row } = params;
  const published = await readSharedGitHubPublication(
    { agentId: row.agent_id, sessionKey: row.session_key, sessionId: row.session_id },
    { status: "published" },
  );
  params.assertCurrent();
  let expectedHead = binding.head.commit;
  if (
    published?.head_commit &&
    published.repository === binding.base.repository &&
    published.base_branch === binding.base.branch &&
    published.pull_request_url === binding.url
  ) {
    const ancestry = await runPublicationCommand(
      ["git", "merge-base", "--is-ancestor", expectedHead, published.head_commit],
      { cwd: params.cwd, beforeRun: params.assertCurrent },
    );
    params.assertCurrent();
    if (ancestry.code === 0) {
      expectedHead = published.head_commit;
    } else if (ancestry.code !== 1) {
      throw new GitHubPublicationRecoveryPendingError(
        "The accepted PR source and previous publication could not be compared; saved work was preserved.",
      );
    }
  }
  let assertInspected: (() => void) | undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    try {
      assertInspected?.();
    } catch {
      throw new GitHubPublicationRequesterUnavailableError();
    }
  };
  const refresh = async () => {
    const inspected = await inspectOwnGitHubPullRequest({
      pullRequestUrl: binding.url,
      agentId: row.agent_id,
      requester: params.requester,
      assertCurrent: params.assertCurrent,
    }).catch(() => {
      throw new GitHubPublicationRequesterUnavailableError();
    });
    assertBoundGitHubPullRequest(binding, inspected.result);
    const observedHead = inspected.result.head!.commit;
    // A retried request may already have pushed its own journaled commit. The executor
    // verifies that commit's exact tree, parent and request marker before any new effect.
    const observedPublication =
      row.head_commit !== row.source_head_commit && observedHead === row.head_commit;
    if (observedHead !== expectedHead && !observedPublication) {
      throw new GitHubPublicationBranchChangedError({ originalPullRequest: true });
    }
    assertInspected = inspected.assertCurrent;
    if (!observedPublication) {
      await assertExistingPullRequestWriteAccess({
        pullRequest: inspected.result,
        identity: await params.refreshIdentity(),
        assertCurrent,
      });
    }
    assertCurrent();
    return observedPublication;
  };
  const observedPublication = await refresh();
  return { assertCurrent, refresh, observedPublication };
}

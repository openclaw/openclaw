import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type {
  GitHubPublicationExecutionRow,
  GitHubPublicationRow,
} from "../state/github-publication-read.types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  readLocalGitHubPublicationWorktreeOwner,
  resolveLocalGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import {
  createGitHubPublicationExecutionIdentity,
  type GitHubPublicationIdentityOwner,
} from "./github-publication-execution-identity.js";
import {
  recoverGitHubPublicationBranchAndIndex,
  GitHubPublicationRecoveryPendingError,
} from "./github-publication-git-index.js";
import { reconcileGitHubPublicationPullRequest } from "./github-publication-pull-requests.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";

export async function recoverGitHubPublicationWorkspace(
  row: GitHubPublicationExecutionRow,
  run: Parameters<typeof recoverGitHubPublicationBranchAndIndex>[0]["run"],
  assertCustody: () => void,
): Promise<void> {
  const worktree = managedWorktrees.findLiveById(row.worktree_id);
  if (
    worktree?.repoFingerprint !== row.repository_fingerprint ||
    worktree.branch !== row.branch ||
    !row.source_head_commit ||
    !row.workspace_tree
  ) {
    return;
  }
  await recoverGitHubPublicationBranchAndIndex({
    cwd: worktree.path,
    requestId: row.request_id,
    branch: row.branch,
    sourceHeadCommit: row.source_head_commit,
    workspaceTree: row.workspace_tree,
    assertCustody,
    run,
  });
}

async function readKnownGitHubPublicationPullRequestUrls(
  row: GitHubPublicationExecutionRow,
): Promise<string[]> {
  const result = await executeExistingOpenClawStateRead(
    {},
    {
      type: "githubPublication.knownPullRequestUrls",
      input: {
        worktree_id: row.worktree_id,
        repository_fingerprint: row.repository_fingerprint,
        repository: row.repository,
        branch: row.branch,
        base_branch: row.base_branch,
        identity_account_id: row.identity_account_id,
        pull_request_url: row.pull_request_url,
      },
    },
    { current: true },
  );
  if (!result?.ok || result.type !== "githubPublication.knownPullRequestUrls") {
    throw new Error("GitHub publication receipt history is unavailable.");
  }
  return result.urls;
}

export async function readGitHubPublicationRequestInWorker(
  requestId: string,
): Promise<GitHubPublicationRow | undefined> {
  const result = await executeExistingOpenClawStateRead(
    {},
    { type: "githubPublication.request", requestId },
    { current: true },
  );
  if (!result?.ok || result.type !== "githubPublication.request") {
    throw new Error("GitHub publication receipt is unavailable.");
  }
  return result.row;
}

/** Lost requester authority permits receipt reconciliation, never a publication retry. */
export async function reconcileGitHubPublication<
  Row extends GitHubPublicationExecutionRow,
>(params: {
  initial: Row;
  identity?: GitHubPublicationIdentityOwner;
  validateCustody: () => boolean;
  pushOnly?: "observed" | "dispatched";
  projectResult: (row: Row) => SessionGitHubPublicationResult;
  complete: (row: Row, result: SessionGitHubPublicationResult) => Row;
}): Promise<SessionGitHubPublicationResult | undefined> {
  const row = params.initial;
  if (row.status === "published" || row.status === "failed") {
    return params.projectResult(row);
  }
  // Shared execution records these facts before dispatching any branch or PR write.
  if (
    !row.repository ||
    !row.base_branch ||
    !row.head_commit ||
    !row.source_head_commit ||
    !row.workspace_tree
  ) {
    return undefined;
  }
  const { assertCurrent, refreshIdentity } = createGitHubPublicationExecutionIdentity({
    row,
    identity: params.identity,
    validateAuthority: params.validateCustody,
    assertWorkspace: () => {
      resolveLocalGitHubPublicationWorktreeOwner(row);
    },
  });
  let url: string | undefined;
  try {
    assertCurrent();
    const { worktree } = await readLocalGitHubPublicationWorktreeOwner(row);
    assertCurrent();
    const target = await prepareGitHubPublicationTarget({
      worktree,
      identity: await refreshIdentity(),
      assertCurrent,
    });
    if (
      target.repository !== row.repository ||
      target.branch !== row.branch ||
      target.baseBranch !== row.base_branch
    ) {
      throw new Error("GitHub publication's original target is unavailable.");
    }
    const knownPullRequestUrls = await readKnownGitHubPublicationPullRequestUrls(row);
    assertCurrent();
    url = await reconcileGitHubPublicationPullRequest({
      requestId: row.request_id,
      pushRepository: target.pushRepository,
      repository: row.repository,
      pushOwner: target.pushOwner,
      branch: row.branch,
      baseBranch: row.base_branch,
      headCommit: row.head_commit,
      workspaceTree: row.workspace_tree,
      parentCommit: row.source_head_commit,
      marker: `<!-- openclaw-publication:${row.request_id} -->`,
      knownPullRequestUrls,
      refreshIdentity,
      assertCurrent,
      pushOnly: params.pushOnly,
    });
  } catch (error) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication is unconfirmed; restore read access to the original target and retry recovery. Recorded effects are retained.",
      { cause: error },
    );
  }
  if (!url) {
    return undefined;
  }
  return params.projectResult(
    params.complete(row, {
      requestId: row.request_id,
      status: "published",
      url,
      repository: row.repository,
      branch: row.branch,
      headCommit: row.head_commit,
    }),
  );
}

import { managedWorktrees } from "../agents/worktrees/service.js";
import type {
  GitHubPublicationExecutionRow,
  GitHubPublicationRow,
} from "../state/github-publication-read.types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { recoverGitHubPublicationBranchAndIndex } from "./github-publication-git-index.js";

type PublicationRow = GitHubPublicationExecutionRow;
type GitCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };

export async function recoverGitHubPublicationWorkspace(
  row: PublicationRow,
  run: (argv: string[], options?: GitCommandOptions) => Promise<string>,
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

export async function readKnownGitHubPublicationPullRequestUrls(
  row: GitHubPublicationExecutionRow,
): Promise<string[]> {
  const {
    worktree_id,
    repository_fingerprint,
    repository,
    branch,
    base_branch,
    identity_account_id,
    pull_request_url,
  } = row;
  const result = await executeExistingOpenClawStateRead(
    {},
    {
      type: "githubPublication.knownPullRequestUrls",
      input: {
        worktree_id,
        repository_fingerprint,
        repository,
        branch,
        base_branch,
        identity_account_id,
        pull_request_url,
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

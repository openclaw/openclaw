import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import { runPublicationCommand } from "./github-publication-git-transport.js";

/** `false` only when the branch is known to be absent; `undefined` when that can't be confirmed. */
export type GitHubBranchPresence = (branch: string) => Promise<boolean | undefined>;

/**
 * Picks the PR base branch from a worktree's recorded base. A worktree created from an
 * abbreviated commit ID records that text, which names a commit rather than a branch the PR
 * can target, so it selects the default branch like a full commit ID does. A hex-looking name
 * stays a branch when a local branch or a GitHub branch has it, or when GitHub can't confirm
 * the branch is absent.
 */
export async function resolveRecordedPublicationBaseBranch(params: {
  cwd: string;
  baseRef: string;
  defaultBranch: string;
  remoteBranchExists: GitHubBranchPresence;
}): Promise<string> {
  const { cwd, baseRef, defaultBranch } = params;
  const asRecorded = () => parseGitHubPublicationBaseBranch(baseRef, defaultBranch);
  const name = baseRef.trim();
  // A full commit ID already selects the default branch.
  if (!/^[0-9a-f]{4,63}$/iu.test(name) || name.length === 40) {
    return asRecorded();
  }
  // Git resolves a bare name to a local branch before an abbreviated object ID.
  const branch = await runPublicationCommand(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`],
    { cwd },
  );
  if (branch.code === 0) {
    return asRecorded();
  }
  const commit = await runPublicationCommand(
    ["git", "rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`],
    { cwd },
  );
  const id = commit.code === 0 ? commit.stdout.toString("utf8").trim().toLowerCase() : "";
  if (!id.startsWith(name.toLowerCase())) {
    return asRecorded();
  }
  return (await params.remoteBranchExists(name)) === false ? defaultBranch : asRecorded();
}

/** Reads whether `branch` exists on GitHub; any lookup failure other than HTTP 404 stays unknown. */
export function gitHubBranchPresence(params: {
  repository: string;
  host: string;
  env: NodeJS.ProcessEnv;
}): GitHubBranchPresence {
  return async (branch) => {
    const result = await runPublicationCommand(
      [
        "gh",
        "api",
        "--hostname",
        params.host,
        `repos/${params.repository}/git/ref/heads/${branch}`,
        "--jq",
        ".ref",
      ],
      { env: params.env },
    );
    if (result.code === 0) {
      return result.stdout.toString("utf8").trim() === `refs/heads/${branch}` ? true : undefined;
    }
    // gh reports a failed API status as "<message> (HTTP <status>)".
    return /\(HTTP 404\)/u.test(result.stderr.toString("utf8")) ? false : undefined;
  };
}

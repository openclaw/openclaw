import fs from "node:fs/promises";
import nodePath from "node:path";
import { runGit } from "../agents/worktrees/git.js";
import type { GitReadOperations } from "../infra/git-read-operations.js";
import { gitOutput, resolveBranchLanding } from "./control-ui-session-prs-landing.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

export async function readCheckoutGitContext(
  root: string,
): Promise<GitReadOperations["checkout.context"]["output"]> {
  const branch = await gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    return null;
  }
  const remoteUrl = await gitOutput(root, ["remote", "get-url", "origin"]);
  const remote = remoteUrl ? parseGitHubRemoteUrl(remoteUrl) : null;
  if (!remote) {
    return null;
  }
  const defaultRef = await gitOutput(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = defaultRef?.replace(/^origin\//, "");
  return { ...remote, branch, root, ...(defaultBranch ? { defaultBranch } : {}) };
}

const SHORTSTAT_FILES = /(\d+) files? changed/;
const SHORTSTAT_INSERTIONS = /(\d+) insertion/;
const SHORTSTAT_DELETIONS = /(\d+) deletion/;
// Matches sessions-diff's untracked scan bound; stats degrade to an
// undercount past it instead of stalling the request.
const MAX_UNTRACKED_STAT_FILES = 100;
// Oversized untracked files count 0 lines instead of being read; the row's
// stats are an approximation, not a patch surface.
const MAX_UNTRACKED_STAT_BYTES = 512 * 1024;

/**
 * Line count for one untracked file, computed in-process: this runs on the
 * chat view's poll, so it must not spawn one git subprocess per path. lstat
 * gates on regular files so FIFOs/sockets can never block the RPC and symlinks
 * never resolve outside the checkout; only a line count is exposed, so
 * sessions-diff's hardlink content guard is unnecessary here.
 */
async function untrackedFileAdditions(root: string, filePath: string): Promise<number> {
  try {
    const abs = nodePath.resolve(root, filePath);
    const info = await fs.lstat(abs);
    if (!info.isFile() || info.size === 0 || info.size > MAX_UNTRACKED_STAT_BYTES) {
      return 0;
    }
    const body = await fs.readFile(abs);
    // Binary files count 0 lines, mirroring git's shortstat behavior.
    if (body.subarray(0, 8192).includes(0)) {
      return 0;
    }
    let lines = 0;
    for (const byte of body) {
      if (byte === 10) {
        lines += 1;
      }
    }
    // A trailing fragment without a newline is still a line git would add.
    return body[body.length - 1] === 10 ? lines : lines + 1;
  } catch {
    // Unreadable paths just do not count toward the size.
    return 0;
  }
}

async function untrackedStats(root: string): Promise<{ additions: number; files: number }> {
  const listing = await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = (listing ?? "").split("\0").filter(Boolean);
  let additions = 0;
  for (const filePath of paths.slice(0, MAX_UNTRACKED_STAT_FILES)) {
    additions += await untrackedFileAdditions(root, filePath);
  }
  return { additions, files: paths.length };
}

/**
 * Working-tree diff counts vs an explicit base, untracked files included:
 * the size the PR would have if the current work were committed and pushed;
 * changedFiles decides row visibility for unpushed branches. Unlike bare
 * `git diff`, this also counts unmerged (conflict) paths.
 */
async function diffStatsAgainst(
  root: string,
  base: string,
): Promise<{ additions: number; deletions: number; changedFiles: number } | null> {
  try {
    // Checkout-configurable diff drivers must never execute in the Gateway
    // process (same guard as sessions-diff).
    const result = await runGit(root, [
      "diff",
      "--shortstat",
      "--no-ext-diff",
      "--no-textconv",
      base,
    ]);
    if (result.code !== 0) {
      return null;
    }
    // Empty output means an empty diff, not a failure.
    const summary = result.stdout.trim();
    const untracked = await untrackedStats(root);
    return {
      additions: Number(SHORTSTAT_INSERTIONS.exec(summary)?.[1] ?? 0) + untracked.additions,
      deletions: Number(SHORTSTAT_DELETIONS.exec(summary)?.[1] ?? 0),
      changedFiles: Number(SHORTSTAT_FILES.exec(summary)?.[1] ?? 0) + untracked.files,
    };
  } catch {
    return null;
  }
}

/**
 * GitHub's pull/new page only has something to offer once the pushed branch
 * carries commits the default branch lacks. Rename-only commits still count:
 * this gate keys on commits, not line counts.
 */
async function branchHasCreatablePullRequest(
  root: string,
  defaultSha: string | null,
  pushedSha: string | null,
  defaultBranch: string | undefined,
): Promise<boolean> {
  // Fail closed when origin/HEAD is missing or the branch is not pushed.
  if (!defaultBranch || !pushedSha) {
    return false;
  }
  if (!defaultSha) {
    return true;
  }
  const ahead = await gitOutput(root, ["rev-list", "--count", `${defaultSha}..${pushedSha}`]);
  // A failed count keeps the row: rev-list errors must not hide a valid branch.
  return ahead === null || Number(ahead) > 0;
}

export async function readPullRequestBranchFacts(
  input: GitReadOperations["pull-request.branch-facts"]["input"],
): Promise<GitReadOperations["pull-request.branch-facts"]["output"]> {
  const landing = await resolveBranchLanding(input.root, input);
  const creatable =
    (!landing.hasLandedPullRequest || landing.provenNewPushedWork) &&
    (await branchHasCreatablePullRequest(
      input.root,
      landing.defaultSha,
      landing.pushedSha,
      input.defaultBranch,
    ));
  const stats = landing.statsBase ? await diffStatsAgainst(input.root, landing.statsBase) : null;
  return !creatable && !(stats && stats.changedFiles > 0) ? undefined : { creatable, stats };
}

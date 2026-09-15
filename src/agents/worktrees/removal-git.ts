import { randomUUID } from "node:crypto";
import { commandError, requireGit, runGit } from "./git.js";
import type { ManagedWorktreeRecord } from "./types.js";

type GitOptions = Parameters<typeof runGit>[2];

export async function requireManagedWorktreeHead(
  record: ManagedWorktreeRecord,
  options: GitOptions,
): Promise<string> {
  const branch = await runGit(record.path, ["symbolic-ref", "--quiet", "HEAD"], options);
  if (branch.code !== 0 || branch.stdout.trim() !== `refs/heads/${record.branch}`) {
    throw new Error(
      `Worktree HEAD no longer owns ${record.branch}; checkout and branch preserved.`,
    );
  }
  return await requireGit(record.path, ["rev-parse", "--verify", "HEAD^{commit}"], options);
}

/** Keep native branch deletion's ancestry and checked-out-elsewhere checks. */
export async function prepareSnapshotBranchDeletion(
  record: ManagedWorktreeRecord,
  snapshotRef: string,
  snapshot: string,
  options: GitOptions,
): Promise<GitOptions> {
  const merges = await runGit(
    record.repoRoot,
    ["config", "--get-all", `branch.${record.branch}.merge`],
    options,
  );
  if (merges.code !== 0 && merges.code !== 1) {
    throw commandError("git config --get-all", merges);
  }
  const source = merges.code === 0 ? merges.stdout.split("\n")[0]! : snapshotRef;
  await requireGit(record.repoRoot, ["check-ref-format", source], options);
  const remote = `openclaw-removal-${randomUUID()}`;
  // branch.merge is multi-valued; appending an upstream cannot replace it.
  // A command-local fetch mapping resolves its first value to our snapshot.
  // No fetch or config write occurs, and args[0] stays "branch" for ref admission.
  const config = [
    `branch.${record.branch}.remote=${remote}`,
    `remote.${remote}.fetch=+${source}:${snapshotRef}`,
    ...(merges.code === 1 ? [`branch.${record.branch}.merge=${source}`] : []),
  ];
  const deletionOptions = {
    ...options,
    env: {
      ...options?.env,
      // Replace inherited parameters: they must not undo hooks/fsmonitor policy.
      GIT_CONFIG_PARAMETERS: config.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "),
    },
  };
  const upstream = await requireGit(
    record.repoRoot,
    ["rev-parse", "--verify", `${record.branch}@{upstream}^{commit}`],
    deletionOptions,
  );
  if (upstream !== snapshot) {
    throw new Error(`Cannot bind branch cleanup to ${snapshotRef}; checkout preserved.`);
  }
  return deletionOptions;
}

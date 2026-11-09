import { formatErrorMessage } from "../../infra/errors.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import {
  commandError,
  listGitWorktrees,
  requireGit,
  resolveGitRepositoryPaths,
  runGit,
} from "./git.js";
import { readPendingWorktrees } from "./pending-slots.js";
import { readRegistryWorktrees } from "./registry-read.js";
import { withWorktreeRunEnd } from "./run-end-lifecycle.js";
import type { CreateManagedWorktreeParams, ManagedWorktreeRecord } from "./types.js";

export type PruneWorktreeBranchesParams = { repoRoot: string; dryRun?: boolean } & Pick<
  CreateManagedWorktreeParams,
  "signal" | "commitGuard"
>;

function branchCleanupEnvironment() {
  // Inherited repository/config overrides must not redirect destructive cleanup.
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
}

export async function pruneManagedWorktreeBranches(
  params: PruneWorktreeBranchesParams,
  env: NodeJS.ProcessEnv,
) {
  return withWorktreeRunEnd(env, () =>
    withWorktreeAllocationLease({ ...params, env }, async (guard) => {
      const { canonicalRoot: repoRoot, commonDir } = await resolveGitRepositoryPaths(
        params.repoRoot,
        {
          baseEnv: branchCleanupEnvironment(),
          signal: guard.signal,
          beforeRun: guard.commitGuard,
        },
      );
      return collectOrphanWorktreeBranches({
        env,
        repoRoot,
        commonDir,
        dryRun: params.dryRun,
        signal: guard.signal,
        commitGuard: guard.commitGuard,
      });
    }),
  );
}

export type WorktreeBranchCleanupResult = {
  repoRoot: string;
  dryRun: boolean;
  branches: {
    branch: string;
    outcome: "would-delete" | "deleted" | "preserved" | "failed";
    reason?: string;
  }[];
};

/** Caller holds allocation custody, or the expiring record's mutation lease. */
export async function collectOrphanWorktreeBranches(params: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  dryRun?: boolean;
  commonDir?: string;
  retiring?: ManagedWorktreeRecord;
  signal?: AbortSignal;
  commitGuard: () => void;
}): Promise<WorktreeBranchCleanupResult> {
  const { repoRoot, retiring } = params;
  const options = {
    baseEnv: branchCleanupEnvironment(),
    signal: params.signal,
    beforeRun: params.commitGuard,
    killProcessTree: true,
    refMutationDirectory: params.commonDir,
    env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
  };
  const refs = await requireGit(
    repoRoot,
    [
      "for-each-ref",
      "--format=%(refname)%09%(symref)",
      retiring ? `refs/heads/${retiring.branch}` : "refs/heads/openclaw/",
      "refs/openclaw/snapshots/",
      "refs/openclaw/removals/",
      "refs/openclaw/restores/",
    ],
    options,
  );
  const entries = refs
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const result: WorktreeBranchCleanupResult = {
    repoRoot,
    dryRun: params.dryRun === true,
    branches: [],
  };
  if (!entries.some(([ref]) => ref!.startsWith("refs/heads/openclaw/"))) {
    return result;
  }
  const [records, pending, worktrees] = await Promise.all([
    readRegistryWorktrees(params.env),
    readPendingWorktrees(params.env),
    listGitWorktrees(repoRoot, options),
  ]);
  params.commitGuard();
  const owners = [...records, ...pending.map(({ record }) => record)].filter(
    (record) => record.repoRoot === repoRoot,
  );
  const protectedBranches = new Set(
    owners.filter((record) => record.id !== retiring?.id).map((record) => record.branch),
  );
  const recoveryRefs = new Set(
    owners.flatMap((record) => [
      record.snapshotRef,
      `refs/openclaw/removals/${record.id}`,
      `refs/openclaw/restores/exact-v1/${record.id}`,
    ]),
  );
  // An unregistered recovery ref has no trustworthy branch mapping. Preserve the
  // repository's candidates until its recovery owner reconciles that evidence.
  const unknownRecovery = entries.find(
    ([ref]) => ref!.startsWith("refs/openclaw/") && !recoveryRefs.has(ref),
  )?.[0];
  const attached = new Set(worktrees.map((entry) => entry.branch));
  const candidates: string[] = [];
  for (const [ref, symbolic] of entries) {
    if (!ref!.startsWith("refs/heads/openclaw/")) {
      continue;
    }
    const branch = ref!.slice("refs/heads/".length);
    if (retiring && branch !== retiring.branch) {
      continue;
    }
    const reason = symbolic
      ? "symbolic branch"
      : attached.has(ref)
        ? "attached worktree"
        : protectedBranches.has(branch)
          ? "registry or pending recovery owner"
          : unknownRecovery
            ? `unregistered recovery ref: ${unknownRecovery}`
            : undefined;
    if (reason) {
      result.branches.push({ branch, outcome: "preserved", reason });
    } else if (params.dryRun) {
      result.branches.push({ branch, outcome: "would-delete" });
    } else {
      candidates.push(branch);
    }
  }
  // Native branch deletion checks linked worktrees once per command. Bound argv
  // size without repeating that repository-wide inventory for every orphan.
  for (let offset = 0; offset < candidates.length; offset += 128) {
    const batch = candidates.slice(offset, offset + 128);
    const deleted = await runGit(repoRoot, ["branch", "-D", "--", ...batch], options);
    if (deleted.code === 0) {
      result.branches.push(...batch.map((branch) => ({ branch, outcome: "deleted" as const })));
      continue;
    }
    // Git can delete some branches and fail others. Reconcile only this partial
    // outcome, never report a successful deletion twice or hide a failed branch.
    const remaining = new Set(
      (
        await requireGit(
          repoRoot,
          ["for-each-ref", "--format=%(refname)", ...batch.map((branch) => `refs/heads/${branch}`)],
          options,
        )
      ).split("\n"),
    );
    const reason = formatErrorMessage(commandError("git branch -D", deleted));
    for (const branch of batch) {
      result.branches.push(
        remaining.has(`refs/heads/${branch}`)
          ? { branch, outcome: "failed", reason }
          : { branch, outcome: "deleted" },
      );
    }
  }
  return result;
}

import path from "node:path";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { withWorktreeAllocationLease, type WorktreeAllocationGuard } from "./allocation.js";
import { evictManagedWorktree } from "./eviction.js";
import { enforceWorktreeCleanupLimits, worktreeCapacityError } from "./gc-limits.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import type {
  GitWorktreeOperations,
  WorktreeEvictionCandidate,
} from "./git-worktree-operations.js";
import { readRegistryWorktrees, readWorktreeCleanupState } from "./registry-read.js";
import { worktreeGcRevision } from "./registry-read.kernel.js";
import { worktreeRunLeaseScope } from "./run-lease-owner.js";
import type { CreateManagedWorktreeParams, ManagedWorktreeRecord } from "./types.js";

type WorktreeCapacityGuard = Pick<CreateManagedWorktreeParams, "signal" | "commitGuard">;
type RepositoryInventory =
  GitWorktreeOperations["worktree.eviction-repositories"]["output"][number];
const DEFAULT_WORKTREE_MAX_COUNT = 4096;

/** Admission and maintenance share ranking, eviction budgets, and the allocation lease. */
export function createWorktreeCapacityOwner({
  env,
  now,
  getConfig = getRuntimeConfig,
}: {
  env: NodeJS.ProcessEnv;
  now: () => number;
  getConfig?: () => OpenClawConfig;
}) {
  const configuredMaxCount = () => getConfig().worktreeMaxCount ?? DEFAULT_WORKTREE_MAX_COUNT;
  // The creation/restore owner retains source custody through native settlement.
  async function admit(guard: WorktreeAllocationGuard): Promise<void> {
    const records = await readRegistryWorktrees(env, { liveOnly: true });
    guard.commitGuard();
    const maxCount = configuredMaxCount();
    if (records.length < maxCount) {
      return;
    }
    const progress = new WorktreeGcProgress();
    const ranked = new Map<string, WorktreeEvictionCandidate>();
    const repositories = new Map<string, RepositoryInventory>();
    let more: boolean;
    do {
      ({ more } = await enforce(maxCount - 1, progress, guard, ranked, repositories));
    } while (progress.result.limitsSatisfied !== true && more);
    if (progress.result.limitsSatisfied !== true) {
      const { records: remainingRecords, leases } = await readWorktreeCleanupState(env);
      const live = new Set(leases.liveScopes);
      throw worktreeCapacityError(
        maxCount,
        remainingRecords.filter(
          (record) => record.removedAt === undefined && live.has(worktreeRunLeaseScope(record.id)),
        ),
      );
    }
  }

  async function enforce(
    maxCount: number,
    progress: WorktreeGcProgress,
    guard: WorktreeAllocationGuard,
    ranked = new Map<string, WorktreeEvictionCandidate>(),
    repositories = new Map<string, RepositoryInventory>(),
  ): Promise<{ removed: string[]; attempted: number; more: boolean }> {
    const started = performance.now();
    let attempted = 0;
    let yielded = false;
    const { leases } = await readWorktreeCleanupState(env);
    const live = new Set(leases.liveScopes);
    const removed = await enforceWorktreeCleanupLimits({
      env,
      maxCount,
      progress,
      hasLiveLease: (record) => live.has(worktreeRunLeaseScope(record.id)),
      repositories: async (records) => {
        const missing = records.filter(
          (record) => !repositories.has(record.id + worktreeGcRevision(record)),
        );
        for (const [key, directory] of await prepareRepositories(missing, guard)) {
          repositories.set(key, directory);
        }
        return records.map((record) => repositories.get(record.id + worktreeGcRevision(record))!);
      },
      classify: async (records) => {
        const missing = records.filter(
          (record) => !ranked.has(record.id + worktreeGcRevision(record)),
        );
        for (const [revision, candidate] of await classify(missing, guard, repositories)) {
          ranked.set(revision, candidate);
        }
        return records.map((record) => ranked.get(record.id + worktreeGcRevision(record))!);
      },
      shouldYield: () =>
        (yielded = attempted > 0 && (attempted >= 8 || performance.now() - started >= 5_000)),
      evict: async (record, reason) => {
        attempted += 1;
        const disposition = await evictManagedWorktree({
          env,
          record,
          reason,
          guard,
          now,
          getConfig,
        });
        const counts = (progress.result.evictions ??= {});
        counts[disposition] = (counts[disposition] ?? 0) + 1;
      },
      onError: async (record, error) => {
        guard.commitGuard();
        progress.error("limits", error, record.id);
      },
    });
    return { removed, attempted, more: yielded || removed.length > 0 };
  }

  async function classify(
    records: ManagedWorktreeRecord[],
    guard: WorktreeCapacityGuard,
    repositories: ReadonlyMap<string, RepositoryInventory>,
    checkpoint?: () => Promise<void>,
  ): Promise<Map<string, WorktreeEvictionCandidate>> {
    const ranked = new Map<string, WorktreeEvictionCandidate>();
    if (records.length === 0) {
      return ranked;
    }
    const { readKnownWorktreeMergedHeads } = await import("../../gateway/worktree-merged-heads.js");
    const config = getConfig();
    for (let offset = 0; offset < records.length; offset += 8) {
      const batch = records.slice(offset, offset + 8);
      const candidates = [];
      for (const record of batch) {
        const repository = repositories.get(record.id + worktreeGcRevision(record));
        candidates.push({
          id: record.id,
          repoRoot: record.repoRoot,
          branch: record.branch,
          head: repository?.heads[path.resolve(record.path)],
          defaultHead: repository?.defaultHead,
          mergedHeads: await readKnownWorktreeMergedHeads(record, config),
        });
      }
      const results = await runGitWorkerOperation(
        { type: "worktree.eviction-classify", input: { records: candidates } },
        {
          signal: guard.signal,
          assertCurrent: guard.commitGuard,
          onEffect: () => guard.commitGuard?.(),
        },
      );
      for (const [index, candidate] of results.entries()) {
        ranked.set(candidate.id + worktreeGcRevision(batch[index]!), candidate);
        await checkpoint?.();
      }
    }
    return ranked;
  }

  async function prepareRepositories(
    records: ManagedWorktreeRecord[],
    guard: WorktreeCapacityGuard,
    checkpoint?: () => Promise<void>,
  ): Promise<Map<string, RepositoryInventory>> {
    const roots = [...new Set(records.map((record) => record.repoRoot))];
    const directories = new Map<string, RepositoryInventory>();
    for (let offset = 0; offset < roots.length; offset += 8) {
      const repoRoots = roots.slice(offset, offset + 8);
      const results = await runGitWorkerOperation(
        { type: "worktree.eviction-repositories", input: { repoRoots } },
        {
          signal: guard.signal,
          assertCurrent: guard.commitGuard,
          onEffect: () => guard.commitGuard?.(),
        },
      );
      for (const directory of results) {
        directories.set(directory.repoRoot, directory);
        await checkpoint?.();
      }
    }
    return new Map(
      records.map((record) => [
        record.id + worktreeGcRevision(record),
        directories.get(record.repoRoot)!,
      ]),
    );
  }

  async function cleanup(params: {
    records: ManagedWorktreeRecord[];
    liveCount: number;
    hasLiveLease: (id: string) => boolean;
    progress: WorktreeGcProgress;
    guard: WorktreeCapacityGuard;
    checkpoint?: () => Promise<void>;
  }): Promise<void> {
    const { records, progress, guard, checkpoint } = params;
    const result = progress.result;
    const maxCount = configuredMaxCount();
    if (params.liveCount <= maxCount) {
      progress.recordLimitState(true);
      return;
    }
    // Rank off the allocation lane; foreground creates may proceed between batches.
    const repositories = await prepareRepositories(
      records.filter((record) => record.removedAt === undefined),
      guard,
      checkpoint,
    );
    const ranked = await classify(
      records.filter((record) => record.removedAt === undefined && !params.hasLiveLease(record.id)),
      guard,
      repositories,
      checkpoint,
    );
    do {
      const batch = await withWorktreeAllocationLease({ ...guard, env }, (allocation) =>
        enforce(maxCount, progress, allocation, ranked, repositories),
      );
      result.removed.push(...batch.removed);
      for (let count = 0; count < Math.max(1, batch.attempted); count += 1) {
        await checkpoint?.();
      }
      if (!batch.more) {
        break;
      }
    } while (result.limitsSatisfied === false);
  }

  return { admit, cleanup };
}

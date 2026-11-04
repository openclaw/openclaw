import path from "node:path";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withWorktreeAllocationLease, type WorktreeAllocationGuard } from "./allocation.js";
import { WorktreePendingContentionError } from "./errors.js";
import { evictManagedWorktree } from "./eviction.js";
import { indexWorktreeEvictionDependencies } from "./gc-dependencies.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import type {
  GitWorktreeOperations,
  WorktreeEvictionCandidate,
} from "./git-worktree-operations.js";
import { readPendingWorktrees, readWorktreeSlotCount } from "./pending-slots.js";
import {
  readLiveRegistryWorktreeIds,
  readRegistryWorktrees,
  readWorktreeCleanupState,
} from "./registry-read.js";
import { worktreeGcRevision } from "./registry-read.kernel.js";
import { worktreeRunLeaseScope } from "./run-lease-owner.js";
import type { CreateManagedWorktreeParams, ManagedWorktreeRecord } from "./types.js";

type WorktreeCapacityGuard = Pick<CreateManagedWorktreeParams, "signal" | "commitGuard">;
type RepositoryInventory =
  GitWorktreeOperations["worktree.eviction-repositories"]["output"][number];
const DEFAULT_WORKTREE_MAX_COUNT = 4096;
const log = createSubsystemLogger("agents/worktrees");

/** Admission and maintenance share ranking, eviction budgets, and the allocation lease. */
export function createWorktreeCapacityOwner({
  env,
  getConfig = getRuntimeConfig,
}: {
  env: NodeJS.ProcessEnv;
  getConfig?: () => OpenClawConfig;
}) {
  const configuredMaxCount = () => getConfig().worktreeMaxCount ?? DEFAULT_WORKTREE_MAX_COUNT;
  // The creation/restore owner retains source custody through native settlement.
  async function admit(guard: WorktreeAllocationGuard): Promise<void> {
    const occupied = await readWorktreeSlotCount(env);
    guard.commitGuard();
    const maxCount = configuredMaxCount();
    if (occupied < maxCount) {
      return;
    }
    // A pending creator can publish during planning; retain its wait/retry target.
    const pending = (await readPendingWorktrees(env)).find(({ state }) => state === "pending");
    const progress = new WorktreeGcProgress();
    const ranked = new Map<string, WorktreeEvictionCandidate>();
    const repositories = new Map<string, RepositoryInventory>();
    let more: boolean;
    do {
      ({ more } = await enforce(maxCount - 1, progress, guard, ranked, repositories));
    } while (progress.result.limitsSatisfied !== true && more);
    if (progress.result.limitsSatisfied !== true) {
      if (pending) {
        throw new WorktreePendingContentionError(pending.record.id);
      }
      const { records: remainingRecords, leases } = await readWorktreeCleanupState(env);
      const live = new Set(leases.liveScopes);
      const owners = remainingRecords
        .filter(
          (record) => record.removedAt === undefined && live.has(worktreeRunLeaseScope(record.id)),
        )
        .map((record) => `${record.ownerKind}:${record.ownerId ?? record.id}`)
        .join(", ");
      const nextStep = owners
        ? "Wait for active runs to finish or raise worktreeMaxCount in the Gateway configuration."
        : "Run openclaw worktrees gc to continue cleanup or raise worktreeMaxCount in the Gateway configuration.";
      throw new Error(
        `Managed worktree cap ${maxCount} reached${owners ? `; live owners: ${owners}` : ""}. ${nextStep}`,
      );
    }
  }

  async function enforce(
    maxCount: number,
    progress: WorktreeGcProgress,
    guard: WorktreeAllocationGuard,
    ranked: Map<string, WorktreeEvictionCandidate>,
    repositories: Map<string, RepositoryInventory>,
  ): Promise<{ removed: string[]; attempted: number; more: boolean }> {
    const started = performance.now();
    let attempted = 0;
    let yielded = false;
    const { leases } = await readWorktreeCleanupState(env);
    const live = new Set(leases.liveScopes);
    const cached =
      <T>(
        cache: Map<string, T>,
        prepare: (records: ManagedWorktreeRecord[]) => Promise<Map<string, T>>,
      ) =>
      async (records: ManagedWorktreeRecord[]) => {
        const missing = records.filter(
          (record) => !cache.has(record.id + worktreeGcRevision(record)),
        );
        for (const [key, value] of await prepare(missing)) {
          cache.set(key, value);
        }
        return records.map((record) => cache.get(record.id + worktreeGcRevision(record))!);
      };
    const records = await readRegistryWorktrees(env, { liveOnly: true });
    const refresh = async () => {
      const liveIds = new Set(await readLiveRegistryWorktreeIds(env));
      return { liveIds, exceeded: (await readWorktreeSlotCount(env)) > maxCount };
    };
    let state = await refresh();
    if (!state.exceeded) {
      progress.result.limitsSatisfied = true;
      return { removed: [], attempted, more: false };
    }
    const idle: ManagedWorktreeRecord[] = [];
    const leased = new Set<string>();
    for (const record of records) {
      if (live.has(worktreeRunLeaseScope(record.id))) {
        leased.add(record.id);
        if (progress.start(record.id)) {
          const owner = `${record.ownerKind}:${record.ownerId ?? record.id}`;
          progress.protect("limits", record.id, "live-refused", `${owner} has an active run lease`);
          log.info(`Worktree eviction live-refused: ${record.id}; owner ${owner}`);
        }
      } else {
        idle.push(record);
      }
    }
    const commonDirs = new Map(
      (idle.length
        ? await cached(repositories, (missing) => prepareRepositories(missing, guard))(records)
        : []
      ).map(({ repoRoot, commonDir }) => [repoRoot, commonDir]),
    );
    const { dependents, sourceContainers, unresolved } = indexWorktreeEvictionDependencies(
      records,
      commonDirs,
    );
    const unknownLive = [...unresolved.keys()].some((id) => leased.has(id));
    const blocked = (id: string) => {
      if (unknownLive) {
        return true;
      }
      for (const child of dependents.get(id) ?? []) {
        if (state.liveIds.has(child)) {
          return true;
        }
      }
      return false;
    };
    const reasons = new Map(
      (await cached(ranked, (missing) => classify(missing, guard, repositories))(idle)).map(
        ({ id, reason }) => [id, reason],
      ),
    );
    const rank = (record: ManagedWorktreeRecord) => {
      const reason = reasons.get(record.id);
      return reason === "merged" ? 0 : reason === "squashed" ? 1 : 2;
    };
    idle.sort(
      (a, b) => rank(a) - rank(b) || a.lastActiveAt - b.lastActiveAt || a.id.localeCompare(b.id),
    );
    const removed: string[] = [];
    for (const record of idle) {
      if (
        !state.exceeded ||
        (yielded = attempted > 0 && (attempted >= 8 || performance.now() - started >= 5_000))
      ) {
        break;
      }
      // Allocation owns checkout and repository dependencies. An external checkout
      // may keep its source or shared Git metadata inside this candidate.
      // This is a dependency, not a failed attempt: revisit after a child retires.
      if (blocked(record.id)) {
        continue;
      }
      if (state.liveIds.has(record.id) && progress.start(record.id)) {
        try {
          // Selection is advisory. The host claims removal atomically against run
          // admission, then revalidates its claim immediately before worker writes.
          progress.result.eligibleCount += 1;
          attempted += 1;
          const disposition = await evictManagedWorktree({
            env,
            record,
            reason: reasons.get(record.id) ?? "idle-age",
            guard,
            getConfig,
          });
          const counts = (progress.result.evictions ??= {});
          counts[disposition] = (counts[disposition] ?? 0) + 1;
          removed.push(record.id);
          const containers = [...(sourceContainers.get(record.id) ?? [])].filter((id) =>
            state.liveIds.has(id),
          );
          if (containers.length > 0) {
            log.warn(
              `Worktree ${record.id} recovery remains inside managed checkout(s) ${containers.join(", ")}; evicting them can also remove its recovery snapshot`,
            );
          }
        } catch (error) {
          guard.commitGuard();
          progress.error("limits", error, record.id);
        }
      }
      state = await refresh();
    }
    progress.result.limitsSatisfied = !state.exceeded;
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
    hasLiveLease: (id: string) => boolean;
    progress: WorktreeGcProgress;
    guard: WorktreeCapacityGuard;
    checkpoint: () => Promise<void>;
  }): Promise<void> {
    const { records, progress, guard, checkpoint } = params;
    const result = progress.result;
    const maxCount = configuredMaxCount();
    if ((await readWorktreeSlotCount(env)) <= maxCount) {
      result.limitsSatisfied = true;
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
        await checkpoint();
      }
      if (!batch.more) {
        break;
      }
    } while (result.limitsSatisfied === false);
  }

  return { admit, cleanup };
}

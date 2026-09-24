import { withWorktreeAllocationLease } from "./allocation.js";
import { directorySizeBytes } from "./capacity.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import { commandError, runGit } from "./git.js";
import { readLiveRegistryWorktreeIds, readRegistryWorktrees } from "./registry-read.js";
import { findPendingWorktreeRemoval } from "./registry.js";
import { WorktreeRemovalIncompleteError, WorktreeRemovalLockError } from "./removal-errors.js";
import { WorktreeRemovalContentionError } from "./run-lease-owner.js";
import type { ManagedWorktreeRecord } from "./types.js";

type EnforceWorktreeCleanupLimitsParams = {
  env: NodeJS.ProcessEnv;
  limits: { maxCount?: number; maxTotalSizeBytes?: number };
  progress: WorktreeGcProgress;
  protect: (record: ManagedWorktreeRecord) => Promise<string | undefined>;
  remove: (record: ManagedWorktreeRecord, assertPressure: () => Promise<void>) => Promise<void>;
};

/** Inspect every contributing row, including a later/protected eviction candidate. */
async function assertRecoveryPins(env: NodeJS.ProcessEnv): Promise<void> {
  const records = await readRegistryWorktrees(env).catch((error: unknown) => {
    throw new WorktreeRemovalIncompleteError(error);
  });
  const live = records.filter((record) => record.removedAt === undefined);
  const refsByRepo = new Map<string, Set<string>>();
  for (const record of live) {
    try {
      let refs = refsByRepo.get(record.repoRoot);
      if (!refs) {
        // A failed remover may have deleted its checkout and released its claim,
        // but retained a recovery pin and live row. Share the probe per repository.
        const result = await runGit(record.repoRoot, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/removals/",
        ]);
        if (result.code !== 0) {
          throw commandError("git for-each-ref", result);
        }
        refs = new Set(result.stdout.split("\n"));
        refsByRepo.set(record.repoRoot, refs);
      }
      if (refs.has(`refs/openclaw/removals/${record.id}`)) {
        throw new Error(`Pending removal for ${record.id}; recover it before pressure cleanup`);
      }
    } catch (error) {
      throw new WorktreeRemovalIncompleteError(error, record.id);
    }
  }
}

function assertNoPendingRemovals(env: NodeJS.ProcessEnv, liveIds: ReadonlySet<string>): void {
  // Lossless run-end cleanup can claim without the allocation lease. Observe
  // every claim together after all awaited probes, not once per earlier row.
  let pendingId: string | undefined;
  try {
    pendingId = findPendingWorktreeRemoval(env, [...liveIds]);
  } catch (error) {
    throw new WorktreeRemovalIncompleteError(error);
  }
  if (pendingId !== undefined) {
    throw new WorktreeRemovalContentionError(
      "busy",
      `Worktree removal is pending for ${pendingId}; cleanup pressure is unresolved`,
      true,
    );
  }
}

/** Enforces retention caps without retrying a record already handled by idle cleanup. */
export async function enforceWorktreeCleanupLimits(
  params: EnforceWorktreeCleanupLimitsParams,
): Promise<string[]> {
  const { limits, progress } = params;
  if (limits.maxCount === undefined && limits.maxTotalSizeBytes === undefined) {
    progress.recordLimitState(true);
    return [];
  }
  // A deleted checkout can still have a live registry row. Do not spend that
  // unresolved pressure on another eviction, including after idle cleanup.
  if (progress.hasUnreconciledRemoval) {
    progress.recordLimitState(false);
    return [];
  }
  const live = (await readRegistryWorktrees(params.env)).filter(
    (record) => record.removedAt === undefined,
  );
  const sizes = new Map<string, number>();
  let totalBytes = 0;
  let inventoryComplete = true;
  if (limits.maxTotalSizeBytes !== undefined) {
    for (const record of live) {
      try {
        const bytes = await directorySizeBytes(record.path);
        sizes.set(record.id, bytes);
        totalBytes += bytes;
      } catch (error) {
        inventoryComplete = false;
        progress.error("size", error, record.id);
      }
    }
  }
  let liveCount = live.length;
  const overLimit = () =>
    (limits.maxCount !== undefined && liveCount > limits.maxCount) ||
    (limits.maxTotalSizeBytes !== undefined && totalBytes > limits.maxTotalSizeBytes);
  // Concurrent changes must affect every destructive decision and the final
  // result. New records stay unmeasured rather than receiving a false size.
  const refreshTotals = async () => {
    const liveIds = new Set(await readLiveRegistryWorktreeIds(params.env));
    liveCount = liveIds.size;
    if (limits.maxTotalSizeBytes !== undefined) {
      totalBytes = 0;
      inventoryComplete = true;
      for (const id of liveIds) {
        const bytes = sizes.get(id);
        if (bytes === undefined) {
          inventoryComplete = false;
        } else {
          totalBytes += bytes;
        }
      }
    }
    return { liveIds, inventoryComplete };
  };
  const inventoriedIds = new Set(live.map((record) => record.id));
  const recordNewIds = (liveIds: Set<string>) => {
    for (const id of liveIds) {
      if (!inventoriedIds.has(id)) {
        progress.record("limits", "deferred", "created during cleanup; run cleanup again", id);
      }
    }
  };
  if (limits.maxTotalSizeBytes !== undefined) {
    await refreshTotals();
  }
  const recordLimitState = async () => {
    try {
      return await withWorktreeAllocationLease({ env: params.env }, async () => {
        try {
          await assertRecoveryPins(params.env);
        } catch (error) {
          progress.error("limits", error);
        }
        // Keep the whole reporting snapshot under removal authority. Missing-row
        // retirement may still run independently, so refresh membership last.
        const { liveIds } = await refreshTotals();
        try {
          assertNoPendingRemovals(params.env, liveIds);
        } catch (error) {
          progress.error("limits", error);
        }
        progress.recordLimitState(!overLimit(), inventoryComplete);
        return liveIds;
      });
    } catch (error) {
      // Failure to acquire or retain reporting authority leaves compliance
      // unknown, but must not discard the result or skip later GC maintenance.
      progress.hasUnreconciledRemoval = true;
      progress.error("limits", error);
      progress.recordLimitState(false);
      return undefined;
    }
  };
  if (!overLimit()) {
    const remainingIds = await recordLimitState();
    if (remainingIds !== undefined && progress.result.limitsSatisfied !== true) {
      recordNewIds(remainingIds);
    }
    return [];
  }
  const removed: string[] = [];
  const candidates = live
    .filter((record) => record.ownerKind === "workboard" || record.ownerKind === "session")
    .toSorted((a, b) => a.lastActiveAt - b.lastActiveAt);
  for (const record of candidates) {
    const { liveIds } = await refreshTotals();
    if (!overLimit()) {
      break;
    }
    if (!liveIds.has(record.id) || !progress.start(record.id)) {
      continue;
    }
    try {
      const protection = await params.protect(record);
      if (protection !== undefined) {
        progress.protect("limits", record.id, protection);
        continue;
      }
      await params.remove(record, async () => {
        // The service calls this once under its allocation lease, not during
        // finalization after this removal has itself relieved the pressure.
        await assertRecoveryPins(params.env);
        // Missing-row retirement can run outside the allocation lease. Read
        // current membership after reconciliation, then check claims last.
        const { liveIds: currentLiveIds } = await refreshTotals();
        assertNoPendingRemovals(params.env, currentLiveIds);
        if (!overLimit()) {
          throw new WorktreeRemovalLockError("busy", "worktree cleanup pressure changed");
        }
      });
    } catch (error) {
      progress.error("limits", error, record.id);
      if (progress.hasUnreconciledRemoval) {
        progress.recordLimitState(false);
        return removed;
      }
      continue;
    }
    removed.push(record.id);
  }
  const remainingIds = await recordLimitState();
  if (remainingIds !== undefined && progress.result.limitsSatisfied !== true) {
    for (const record of live) {
      if (!remainingIds.has(record.id) || !progress.start(record.id)) {
        continue;
      }
      if (record.ownerKind !== "workboard" && record.ownerKind !== "session") {
        progress.protect("limits", record.id, "manual worktrees require explicit removal");
      }
    }
    recordNewIds(remainingIds);
  }
  return removed;
}

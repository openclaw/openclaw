import { directorySizeBytes } from "./capacity.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import { readLiveRegistryWorktreeIds, readRegistryWorktrees } from "./registry-read.js";
import type { ManagedWorktreeRecord } from "./types.js";

type EnforceWorktreeCleanupLimitsParams = {
  env: NodeJS.ProcessEnv;
  limits: { maxCount?: number; maxTotalSizeBytes?: number };
  progress: WorktreeGcProgress;
  protect: (record: ManagedWorktreeRecord) => Promise<string | undefined>;
  remove: (record: ManagedWorktreeRecord) => Promise<void>;
  onError: (record: ManagedWorktreeRecord, error: unknown) => Promise<void>;
};

/** Enforces retention caps without retrying a record already handled by idle cleanup. */
export async function enforceWorktreeCleanupLimits(
  params: EnforceWorktreeCleanupLimitsParams,
): Promise<string[]> {
  const { limits, progress } = params;
  if (limits.maxCount === undefined && limits.maxTotalSizeBytes === undefined) {
    progress.recordLimitState(true);
    return [];
  }
  const live = await readRegistryWorktrees(params.env, { liveOnly: true });
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
  // Count-only inventory has not yielded since its registry read.
  const initialRefresh =
    limits.maxTotalSizeBytes === undefined
      ? { liveIds: inventoriedIds, inventoryComplete }
      : await refreshTotals();
  if (!overLimit()) {
    progress.recordLimitState(true, inventoryComplete);
    if (progress.result.limitsSatisfied !== true) {
      recordNewIds(initialRefresh.liveIds);
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
      await params.remove(record);
    } catch (error) {
      await params.onError(record, error);
      continue;
    }
    removed.push(record.id);
  }
  const { liveIds: remainingIds, inventoryComplete: finalInventoryComplete } =
    await refreshTotals();
  progress.recordLimitState(!overLimit(), finalInventoryComplete);
  if (progress.result.limitsSatisfied !== true) {
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

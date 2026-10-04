import { createSubsystemLogger } from "../../logging/subsystem.js";
import { indexWorktreeEvictionDependencies } from "./gc-dependencies.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import type {
  WorktreeEvictionCandidate,
  WorktreeEvictionReason,
} from "./git-worktree-operations.js";
import { readLiveRegistryWorktreeIds, readRegistryWorktrees } from "./registry-read.js";
import type { ManagedWorktreeRecord } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

type EnforceWorktreeCleanupLimitsParams = {
  env: NodeJS.ProcessEnv;
  maxCount: number;
  progress: WorktreeGcProgress;
  hasLiveLease: (record: ManagedWorktreeRecord) => boolean | Promise<boolean>;
  repositories: (
    records: ManagedWorktreeRecord[],
  ) => Promise<Array<{ repoRoot: string; commonDir?: string }>>;
  classify: (records: ManagedWorktreeRecord[]) => Promise<WorktreeEvictionCandidate[]>;
  evict: (record: ManagedWorktreeRecord, reason: WorktreeEvictionReason) => Promise<void>;
  onError: (record: ManagedWorktreeRecord, error: unknown) => Promise<void>;
  shouldYield?: () => boolean;
};

/** Call under the allocation lease shared by create, restore and background maintenance. */
export async function enforceWorktreeCleanupLimits(
  params: EnforceWorktreeCleanupLimitsParams,
): Promise<string[]> {
  const { maxCount, progress } = params;
  const records = await readRegistryWorktrees(params.env, { liveOnly: true });
  const refresh = async () => {
    const liveIds = new Set(await readLiveRegistryWorktreeIds(params.env));
    return { liveIds, exceeded: liveIds.size > maxCount };
  };
  let state = await refresh();
  if (!state.exceeded) {
    progress.recordLimitState(true);
    return [];
  }
  const idle: ManagedWorktreeRecord[] = [];
  const leased = new Set<string>();
  for (const record of records) {
    if (await params.hasLiveLease(record)) {
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
    (idle.length ? await params.repositories(records) : []).map(({ repoRoot, commonDir }) => [
      repoRoot,
      commonDir,
    ]),
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
  const reasons = new Map((await params.classify(idle)).map(({ id, reason }) => [id, reason]));
  const rank = (record: ManagedWorktreeRecord) => {
    const reason = reasons.get(record.id);
    return reason === "merged" ? 0 : reason === "squashed" ? 1 : 2;
  };
  idle.sort(
    (a, b) => rank(a) - rank(b) || a.lastActiveAt - b.lastActiveAt || a.id.localeCompare(b.id),
  );
  const removed: string[] = [];
  for (const record of idle) {
    if (!state.exceeded || params.shouldYield?.()) {
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
        await params.evict(record, reasons.get(record.id) ?? "idle-age");
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
        await params.onError(record, error);
      }
    }
    state = await refresh();
  }
  progress.recordLimitState(!state.exceeded);
  return removed;
}

export function worktreeCapacityError(
  maxCount: number,
  liveOwners: ManagedWorktreeRecord[],
): Error {
  const owners = liveOwners
    .map((record) => `${record.ownerKind}:${record.ownerId ?? record.id}`)
    .join(", ");
  const nextStep = owners
    ? "Wait for active runs to finish or raise worktreeMaxCount in the Gateway configuration."
    : "Run openclaw worktrees gc to continue cleanup or raise worktreeMaxCount in the Gateway configuration.";
  return new Error(
    `Managed worktree cap ${maxCount} reached${owners ? `; live owners: ${owners}` : ""}. ${nextStep}`,
  );
}

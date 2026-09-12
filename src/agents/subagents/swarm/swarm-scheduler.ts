import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { hasRetainedPluginRuntimeCloseError } from "../../../plugins/runtime-close-error.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";

type SwarmRemovalReason = "cancelled" | "shutdown";

type SwarmLaunch = {
  start: () => Promise<void>;
  /** True once failure is durable or the row no longer owns queued work. */
  onStartFailure: (error: unknown) => boolean | Promise<boolean>;
  /** Release preparation only after an abandoned launch can no longer use it. */
  onRemoved?: (reason: SwarmRemovalReason) => Promise<void>;
  lifecycleOwner?: object;
};

type QueuedSwarmRun = {
  runId: string;
  owner?: object;
  onCapacityChange?: () => void;
  reportedCapacityWait?: boolean;
  launch?: SwarmLaunch;
  pendingLaunch?: Promise<void>;
  removal?: Promise<void>;
  holds: number;
  retryReady: boolean;
};

type SwarmGroupLane = {
  groupId: string;
  limit: number;
  active: Set<string>;
  queue: QueuedSwarmRun[];
  pumpScheduled: boolean;
};

const lanes = new Map<string, SwarmGroupLane>();
const pendingRemovals = new Set<QueuedSwarmRun>();
const runLocations = new Map<
  string,
  | { lane: SwarmGroupLane; state: "active"; item?: QueuedSwarmRun }
  | { lane: SwarmGroupLane; state: "queued"; item: QueuedSwarmRun }
>();

function publishCapacityChange(item: QueuedSwarmRun) {
  if (!item.owner || !item.onCapacityChange) {
    return;
  }
  const waiting = isSwarmRunWaitingForCapacity(item.runId, item.owner);
  if (waiting !== (item.reportedCapacityWait === true)) {
    item.reportedCapacityWait = waiting;
    item.onCapacityChange();
  }
}

function publishLaneCapacityChange(lane: SwarmGroupLane, previouslyFull: boolean) {
  if (previouslyFull !== lane.active.size >= lane.limit) {
    for (const item of lane.queue) {
      publishCapacityChange(item);
    }
  }
}

function finalizeRemovedRun(
  item: QueuedSwarmRun,
  reason: SwarmRemovalReason = "cancelled",
): Promise<void> {
  const onRemoved = item.launch?.onRemoved;
  if (item.launch && !item.removal) {
    pendingRemovals.add(item);
    const cleanup = async () => {
      const [launch] = await Promise.allSettled([item.pendingLaunch]);
      const work = new AsyncWorkScope();
      try {
        await work.track(() => onRemoved?.(reason));
      } finally {
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => work.run(() => work.drain()),
        );
      }
      if (launch.status === "rejected") {
        throw launch.reason;
      }
    };
    // A retained launch can finish after its triggering request's work scope closes.
    item.removal = getAsyncWorkSignal()?.aborted ? cleanup() : trackAsyncWork(cleanup);
    void item.removal.then(
      () => pendingRemovals.delete(item),
      (error: unknown) => {
        console.warn(`[swarm] Failed queued launch cleanup: ${sanitizeForLog(String(error))}`);
      },
    );
  }
  return item.removal ?? Promise.resolve();
}

async function startQueuedRun(lane: SwarmGroupLane, item: QueuedSwarmRun, launch: SwarmLaunch) {
  lane.active.add(item.runId);
  runLocations.set(item.runId, { lane, state: "active", item });
  publishCapacityChange(item);
  publishLaneCapacityChange(lane, false);
  try {
    // Acquiring capacity and invoking launch are one synchronous dispatch boundary.
    await launch.start();
  } catch (error) {
    let failurePersisted = false;
    try {
      failurePersisted = await launch.onStartFailure(error);
    } catch {
      // A durable queued row still owns this work; retry after a short backoff.
    }
    const location = runLocations.get(item.runId);
    if (location?.state !== "active" || location.lane !== lane || location.item !== item) {
      void finalizeRemovedRun(item);
      return;
    }
    if (failurePersisted) {
      releaseSwarmRun(item.runId);
      return;
    }
    const previouslyFull = lane.active.size >= lane.limit;
    lane.active.delete(item.runId);
    item.retryReady = false;
    lane.queue.unshift(item);
    runLocations.set(item.runId, { lane, state: "queued", item });
    publishLaneCapacityChange(lane, previouslyFull);
    const timer = setTimeout(
      () => {
        item.retryReady = true;
        if (runLocations.get(item.runId)?.item === item) {
          publishCapacityChange(item);
        }
        pumpLane(lane);
      },
      isFastTestRuntimeEnv() ? 1 : 1_000,
    );
    timer.unref?.();
  }
}

function pumpLane(lane: SwarmGroupLane) {
  if (lane.pumpScheduled) {
    return;
  }
  lane.pumpScheduled = true;
  queueMicrotask(() => {
    lane.pumpScheduled = false;
    while (lanes.get(lane.groupId) === lane && lane.active.size < lane.limit) {
      const next = lane.queue[0];
      if (!next?.launch || !next.retryReady || next.holds > 0) {
        return;
      }
      lane.queue.shift();
      const completion = createDeferredCore();
      next.pendingLaunch = completion.promise;
      void startQueuedRun(lane, next, next.launch).then(completion.resolve, completion.reject);
    }
  });
}

function ensureLane(params: {
  groupId: string;
  maxConcurrent: number;
  activeRunIds: readonly string[];
}): SwarmGroupLane {
  const lane = lanes.get(params.groupId) ?? {
    groupId: params.groupId,
    limit: params.maxConcurrent,
    active: new Set<string>(),
    queue: [],
    pumpScheduled: false,
  };
  const previouslyFull = lane.active.size >= lane.limit;
  lanes.set(params.groupId, lane);
  lane.limit = params.maxConcurrent;
  for (const runId of params.activeRunIds) {
    // A live reservation is newer than a restored active snapshot. Reclassifying
    // it here would leave its queue node behind and block FIFO admission.
    if (runLocations.has(runId)) {
      continue;
    }
    lane.active.add(runId);
    runLocations.set(runId, { lane, state: "active" });
  }
  publishLaneCapacityChange(lane, previouslyFull);
  return lane;
}

function deleteLaneIfIdle(lane: SwarmGroupLane): void {
  if (lanes.get(lane.groupId) === lane && lane.active.size === 0 && lane.queue.length === 0) {
    lanes.delete(lane.groupId);
  }
}

/** Reserve FIFO position before asynchronous spawn preparation begins. */
export function reserveSwarmRun(params: {
  groupId: string;
  runId: string;
  maxConcurrent: number;
  activeRunIds: readonly string[];
}): boolean {
  const lane = ensureLane(params);
  if (runLocations.has(params.runId)) {
    deleteLaneIfIdle(lane);
    return false;
  }
  const item: QueuedSwarmRun = { runId: params.runId, holds: 0, retryReady: true };
  lane.queue.push(item);
  runLocations.set(params.runId, { lane, state: "queued", item });
  return true;
}

/** Bind a committed registration without transferring a retained reservation to a replacement. */
export function bindSwarmRunReservation(
  runId: string,
  owner: object,
  onCapacityChange?: () => void,
): void {
  const item = runLocations.get(runId)?.item;
  if (item && item.owner === undefined) {
    item.owner = owner;
    item.onCapacityChange = onCapacityChange;
    publishCapacityChange(item);
  }
}

/** Includes held/preactivation work and the launch awaiting Gateway acceptance. */
export function ownsSwarmRunReservation(runId: string, owner: object): boolean {
  return runLocations.get(runId)?.item?.owner === owner;
}

/** Preparation, cancellation holds, and already-admitted launches are not slot waits. */
export function isSwarmRunWaitingForCapacity(runId: string, owner: object): boolean {
  const location = runLocations.get(runId);
  return Boolean(
    location?.state === "queued" &&
    location.item.owner === owner &&
    location.item.launch &&
    location.item.retryReady &&
    location.item.holds === 0 &&
    location.lane.active.size >= location.lane.limit,
  );
}

/** Attach launch work to an existing FIFO reservation. */
export function activateSwarmRun(
  params: SwarmLaunch & {
    groupId: string;
    runId: string;
  },
): void {
  const location = runLocations.get(params.runId);
  if (!location || location.state !== "queued" || location.lane.groupId !== params.groupId) {
    throw new Error(`swarm scheduler reservation missing for run ${params.runId}`);
  }
  const { lane, item } = location;
  item.launch = {
    start: params.start,
    onStartFailure: params.onStartFailure,
    onRemoved: params.onRemoved,
    lifecycleOwner: params.lifecycleOwner,
  };
  publishCapacityChange(item);
  pumpLane(lane);
}

export function enqueueSwarmRun(
  params: SwarmLaunch & {
    groupId: string;
    runId: string;
    maxConcurrent: number;
    activeRunIds: readonly string[];
  },
): void {
  if (!reserveSwarmRun(params)) {
    throw new Error(`swarm scheduler run already exists: ${params.runId}`);
  }
  activateSwarmRun(params);
}

export function releaseSwarmRun(runId: string): boolean {
  const location = runLocations.get(runId);
  if (!location || location.state !== "active") {
    return false;
  }
  const previouslyFull = location.lane.active.size >= location.lane.limit;
  if (!location.lane.active.delete(runId)) {
    return false;
  }
  runLocations.delete(runId);
  publishLaneCapacityChange(location.lane, previouslyFull);
  pumpLane(location.lane);
  deleteLaneIfIdle(location.lane);
  return true;
}

export function removeQueuedSwarmRun(runId: string): boolean {
  const location = runLocations.get(runId);
  if (!location || location.state !== "queued") {
    return false;
  }
  const index = location.lane.queue.indexOf(location.item);
  if (index < 0) {
    return false;
  }
  location.lane.queue.splice(index, 1);
  runLocations.delete(runId);
  void finalizeRemovedRun(location.item);
  publishCapacityChange(location.item);
  pumpLane(location.lane);
  deleteLaneIfIdle(location.lane);
  return true;
}

/** Retire this Gateway's launch resources while leaving durable queued rows available for restart. */
export async function closeSwarmScheduler(lifecycleOwner?: object): Promise<void> {
  const items = new Set(pendingRemovals);
  for (const location of runLocations.values()) {
    if (location.item?.launch) {
      items.add(location.item);
    }
  }
  const owned = [...items].filter((item) => item.launch?.lifecycleOwner === lifecycleOwner);
  const removal = owned.map((item) => finalizeRemovedRun(item, "shutdown"));
  for (const item of owned) {
    if (runLocations.get(item.runId)?.item === item && !removeQueuedSwarmRun(item.runId)) {
      releaseSwarmRun(item.runId);
    }
  }
  const settled = await Promise.allSettled(removal);
  for (const [index, item] of owned.entries()) {
    const result = settled[index]!;
    if (result.status !== "rejected" || !hasRetainedPluginRuntimeCloseError(result.reason)) {
      pendingRemovals.delete(item);
    }
  }
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Swarm launch cleanup failed");
  }
}

/** True only after launch was invoked (or an already-running slot was restored). */
export function isSwarmRunActive(runId: string): boolean {
  return runLocations.get(runId)?.state === "active";
}

/** Holds this exact reservation, including preparation that has not activated yet. */
export function holdQueuedSwarmRun(runId: string) {
  const location = runLocations.get(runId);
  if (location?.state !== "queued") {
    return undefined;
  }
  const { lane, item } = location;
  item.holds += 1;
  publishCapacityChange(item);
  let released = false;
  return {
    async release() {
      if (!released) {
        released = true;
        item.holds -= 1;
        if (runLocations.get(runId) === location) {
          publishCapacityChange(item);
        }
        pumpLane(lane);
      }
      await item.removal?.catch(() => {});
    },
    withdraw() {
      // A retained durable kill may withdraw only its never-started reservation.
      // Reused IDs and lanes must not inherit an older cancellation scope.
      return !released && runLocations.get(runId) === location && removeQueuedSwarmRun(runId);
    },
  };
}

const testing = {
  reset() {
    lanes.clear();
    runLocations.clear();
    pendingRemovals.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.swarmSchedulerTestApi")] = {
    testing,
  };
}

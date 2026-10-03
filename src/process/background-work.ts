import { getLaneGroup } from "./command-queue.capacity-groups.js";
import { enqueueCommandInLane, publishLaneConfiguration } from "./command-queue.js";
import { getQueueState } from "./command-queue.state.js";
import type { CommandLaneSnapshot, CommandQueueEnqueueOptions } from "./command-queue.types.js";
import { getGatewayRestartDrainSignal } from "./gateway-work-admission.js";
import { CommandLane } from "./lanes.js";

const BACKGROUND_WORK_GROUP = "background-work";
const BACKGROUND_WORK_MAX_CONCURRENT = 3;

/** Register a stable core/plugin owner key, never a session or run identifier.
 * Only leaf work belongs here: a coordinator holding capacity must not await
 * another background task, which could need the same occupied capacity. */
export function createBackgroundWorkOwner(params: { owner: string; maxConcurrent: number }) {
  const owner = params.owner.trim();
  if (!owner) {
    throw new Error("Background work requires a stable owner key");
  }
  if (
    !Number.isInteger(params.maxConcurrent) ||
    params.maxConcurrent < 1 ||
    params.maxConcurrent > BACKGROUND_WORK_MAX_CONCURRENT
  ) {
    throw new Error(
      `Background owner concurrency must be between 1 and ${BACKGROUND_WORK_MAX_CONCURRENT}`,
    );
  }
  const lane = `${CommandLane.Background}:${owner}`;
  const register = () => {
    if (getLaneGroup(lane)) {
      if ((getQueueState().lanes.get(lane)?.maxConcurrent ?? 1) !== params.maxConcurrent) {
        throw new Error(
          `Background owner ${owner} is already registered with different concurrency`,
        );
      }
    } else {
      const group = getQueueState().laneGroups.get(BACKGROUND_WORK_GROUP);
      publishLaneConfiguration({
        lanes: { [lane]: params.maxConcurrent },
        groups: {
          [BACKGROUND_WORK_GROUP]: {
            budget: BACKGROUND_WORK_MAX_CONCURRENT,
            members: [...(group?.members ?? []), lane],
          },
        },
      });
    }
    return lane;
  };
  return {
    get lane() {
      return register();
    },
    enqueue<T>(
      task: (signal: AbortSignal) => Promise<T>,
      options?: CommandQueueEnqueueOptions,
    ): Promise<T> {
      const restartSignal = getGatewayRestartDrainSignal();
      const signal = options?.abortSignal
        ? AbortSignal.any([restartSignal, options.abortSignal])
        : restartSignal;
      return enqueueCommandInLane(
        register(),
        () => {
          signal.throwIfAborted();
          return task(signal);
        },
        { ...options, priority: "background", abortSignal: signal },
      );
    },
  };
}

export function isBackgroundWorkLane(lane: string): boolean {
  return getLaneGroup(lane)?.group === BACKGROUND_WORK_GROUP;
}

export function getBackgroundWorkSnapshot(): CommandLaneSnapshot {
  const { lanes, laneGroups } = getQueueState();
  const group = laneGroups.get(BACKGROUND_WORK_GROUP);
  const snapshot: CommandLaneSnapshot = {
    lane: CommandLane.Background,
    activeCount: 0,
    queuedCount: 0,
    maxConcurrent: BACKGROUND_WORK_MAX_CONCURRENT,
    draining: false,
    generation: 0,
    blockedBy: null,
  };
  // Rich lane snapshots each scan the whole group for capacity. Read existing
  // member state directly so diagnostics stay linear without recreating lanes.
  for (const lane of group?.members ?? []) {
    const state = lanes.get(lane);
    if (!state) {
      continue;
    }
    const activeCount = state.activeTaskIds.size;
    snapshot.activeCount += activeCount;
    snapshot.queuedCount += state.queue.length;
    snapshot.draining ||= state.draining;
    snapshot.generation = Math.max(snapshot.generation, state.generation);
    if (state.queue.length > 0 && activeCount >= state.maxConcurrent) {
      snapshot.blockedBy = "lane";
    }
  }
  if (snapshot.activeCount >= BACKGROUND_WORK_MAX_CONCURRENT) {
    snapshot.blockedBy = "group-budget";
  }
  return snapshot;
}

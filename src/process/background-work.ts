import { getLaneGroup } from "./command-queue.capacity-groups.js";
import { publishLaneConfiguration } from "./command-queue.js";
import { getQueueState } from "./command-queue.state.js";
import type { CommandLaneSnapshot } from "./command-queue.types.js";
import { CommandLane } from "./lanes.js";

const BACKGROUND_WORK_GROUP = "background-work";
const BACKGROUND_WORK_MAX_CONCURRENT = 3;

/** Lazily register Workshop's serial lane, including after queue-state resets. */
export function getSkillWorkshopReviewLane(): string {
  const lane = `${CommandLane.Background}:core:skill-workshop`;
  if (getLaneGroup(lane)) {
    if ((getQueueState().lanes.get(lane)?.maxConcurrent ?? 1) !== 1) {
      throw new Error(
        "Background owner core:skill-workshop is already registered with different concurrency",
      );
    }
  } else {
    const group = getQueueState().laneGroups.get(BACKGROUND_WORK_GROUP);
    publishLaneConfiguration({
      lanes: { [lane]: 1 },
      groups: {
        [BACKGROUND_WORK_GROUP]: {
          budget: BACKGROUND_WORK_MAX_CONCURRENT,
          members: [...(group?.members ?? []), lane],
        },
      },
    });
  }
  return lane;
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
    const activeCount = state.activeTasks.size;
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

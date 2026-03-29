import { resolveEmbeddedSessionLane } from "../../../agents/pi-embedded.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { clearFollowupDrainCallback } from "./drain.js";
import { clearFollowupQueue } from "./state.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
};

const defaultQueueCleanupDeps = {
  resolveEmbeddedSessionLane,
  clearCommandLane,
};

const queueCleanupDeps = {
  ...defaultQueueCleanupDeps,
};

export const __testing = {
  setDepsForTests(deps: Partial<typeof defaultQueueCleanupDeps> | undefined): void {
    queueCleanupDeps.resolveEmbeddedSessionLane =
      deps?.resolveEmbeddedSessionLane ?? defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
    queueCleanupDeps.clearCommandLane =
      deps?.clearCommandLane ?? defaultQueueCleanupDeps.clearCommandLane;
  },
  resetDepsForTests(): void {
    queueCleanupDeps.resolveEmbeddedSessionLane =
      defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
    queueCleanupDeps.clearCommandLane = defaultQueueCleanupDeps.clearCommandLane;
  },
};

export function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  const clearedKeys: string[] = [];

  for (const key of keys) {
    const cleaned = key?.trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    followupCleared += clearFollowupQueue(cleaned);
    clearFollowupDrainCallback(cleaned);
    laneCleared += queueCleanupDeps.clearCommandLane(
      queueCleanupDeps.resolveEmbeddedSessionLane(cleaned),
    );
  }

  return { followupCleared, laneCleared, keys: clearedKeys };
}

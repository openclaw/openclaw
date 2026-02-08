import { resolveEmbeddedSessionLane } from "../../../agents/pi-embedded.js";
import { abortActiveTaskInLane, clearCommandLane } from "../../../process/command-queue.js";
import { clearFollowupQueue } from "./state.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
  activeAborted: number; // Track number of active tasks aborted
};

export function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  let activeAborted = 0; // Count active tasks aborted
  const clearedKeys: string[] = [];

  for (const key of keys) {
    const cleaned = key?.trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    followupCleared += clearFollowupQueue(cleaned);

    // Abort active task in the lane before clearing the queue
    const lane = resolveEmbeddedSessionLane(cleaned);
    if (abortActiveTaskInLane(lane)) {
      activeAborted += 1;
    }

    laneCleared += clearCommandLane(resolveEmbeddedSessionLane(cleaned));
  }

  return { followupCleared, laneCleared, keys: clearedKeys, activeAborted };
}

import { resolveEmbeddedSessionLane } from "../../../agents/pi-embedded.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { defaultRuntime } from "../../../runtime.js";
import { clearFollowupQueue } from "./state.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
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
    laneCleared += clearCommandLane(resolveEmbeddedSessionLane(cleaned));
  }

  if (followupCleared > 0) {
    defaultRuntime.error?.(
      `followup queue: ${followupCleared} queued message(s) discarded on abort (keys=${clearedKeys.join(",")})`,
    );
  }

  return { followupCleared, laneCleared, keys: clearedKeys };
}

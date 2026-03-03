import { resolveEmbeddedSessionLane } from "../../../agents/pi-embedded.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { clearFollowupQueue } from "./state.js";
export function clearSessionQueues(keys) {
    const seen = new Set();
    let followupCleared = 0;
    let laneCleared = 0;
    const clearedKeys = [];
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
    return { followupCleared, laneCleared, keys: clearedKeys };
}

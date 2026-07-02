/** Clears reset-related queues and system events for session keys. */
import { drainSystemEventEntries } from "../../infra/system-events.js";
import { clearSessionQueues, type ClearSessionQueueResult } from "./queue/cleanup.js";
import { forceClearReplyRunForResetBySessionId } from "./reply-run-registry.js";

/** Runtime cleanup result for reset-related queues and system events. */
type ClearSessionResetRuntimeStateResult = ClearSessionQueueResult & {
  systemEventsCleared: number;
  activeReplyRunsCleared: number;
};

/** Clears queued follow-ups and pending system events for reset session keys. */
export function clearSessionResetRuntimeState(
  keys: Array<string | undefined>,
  opts?: { activeReplySessionIds?: Array<string | undefined> },
): ClearSessionResetRuntimeStateResult {
  const cleared = clearSessionQueues(keys);
  let systemEventsCleared = 0;
  let activeReplyRunsCleared = 0;

  for (const key of cleared.keys) {
    systemEventsCleared += drainSystemEventEntries(key).length;
  }

  for (const sessionId of opts?.activeReplySessionIds ?? []) {
    if (
      forceClearReplyRunForResetBySessionId(
        sessionId ?? "",
        new Error("clearing active reply operation for reset session"),
      )
    ) {
      activeReplyRunsCleared += 1;
    }
  }

  return {
    ...cleared,
    systemEventsCleared,
    activeReplyRunsCleared,
  };
}

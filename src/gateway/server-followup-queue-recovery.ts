import { peekRestoredPendingDrainKeys } from "../auto-reply/reply/queue/persist.js";
import { getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/followup-queue-recovery");

/**
 * After a cold gateway restart, followup queues are restored from SQLite but
 * drain callbacks are empty until agent-runner registers one for the route.
 * Wake each affected session so the next agent turn can register a callback
 * and drain restored items via the normal enqueue idle-kick path.
 */
export function wakeRestoredFollowupQueueSessions(): number {
  const pendingKeys = [...peekRestoredPendingDrainKeys()];
  if (pendingKeys.length === 0) {
    return 0;
  }

  let woke = 0;
  for (const key of pendingKeys) {
    const queue = getExistingFollowupQueue(key);
    if (!queue || queue.items.length === 0) {
      continue;
    }
    const sessionKey = queue.items[0]?.run?.sessionKey?.trim() || key;
    const count = queue.items.length;
    enqueueSystemEvent(
      `Restored ${count} pending followup message${count === 1 ? "" : "s"} after gateway restart; they will drain on the next agent turn for this route.`,
      { sessionKey },
    );
    requestHeartbeat({
      source: "followup-queue-restore",
      intent: "immediate",
      reason: "restored-followup-queue",
      sessionKey,
    });
    woke += 1;
  }

  if (woke > 0) {
    log.info(`requested heartbeat wake for ${woke} restored followup queue route(s)`);
  }
  return woke;
}

export function scheduleRestoredFollowupQueueRecovery(params: {
  log: { error: (message: string) => void };
  delayMs?: number;
}): void {
  const delayMs = params.delayMs ?? 1_250;
  const timer = setTimeout(() => {
    try {
      wakeRestoredFollowupQueueSessions();
    } catch (err: unknown) {
      params.log.error(`Followup queue recovery failed: ${String(err)}`);
    }
  }, delayMs);
  timer.unref?.();
}

import {
  consumePersistedFollowups,
  type PersistedFollowupItem,
} from "../auto-reply/reply/queue/persist.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";

/**
 * Replay persisted followup queue items after gateway restart.
 *
 * Injects persisted messages as system events on the relevant sessions.
 * They will be included in the next agent turn (heartbeat, new message,
 * or cron) so the agent can see and respond to them.
 *
 * This is Phase 1: simple, safe, no complex dispatch reconstruction.
 * Phase 2 will add direct re-dispatch through channel plugins.
 */
export async function replayPersistedFollowups(): Promise<void> {
  const queues = await consumePersistedFollowups();
  if (queues.length === 0) {
    return;
  }

  let replayed = 0;
  for (const queue of queues) {
    for (const item of queue.items) {
      if (!item.sessionKey) {
        defaultRuntime.warn?.(
          `Skipping persisted followup with no sessionKey (queue: ${queue.queueKey})`,
        );
        continue;
      }
      const text = formatReplayedMessage(item);
      enqueueSystemEvent(text, { sessionKey: item.sessionKey });
      replayed++;
    }
  }

  if (replayed > 0) {
    defaultRuntime.info?.(
      `Injected ${replayed} persisted followup item(s) as system events for replay`,
    );
  }
}

function formatReplayedMessage(item: PersistedFollowupItem): string {
  const sender = item.senderName ?? item.senderUsername ?? item.senderId ?? "unknown";
  const channel = item.originatingChannel ?? "unknown";
  const age = Date.now() - item.enqueuedAt;
  const ageStr =
    age < 60_000
      ? `${Math.round(age / 1000)}s ago`
      : age < 3_600_000
        ? `${Math.round(age / 60_000)}m ago`
        : `${Math.round(age / 3_600_000)}h ago`;

  return (
    `[Replayed message — queued ${ageStr} before restart, from ${sender} via ${channel}]\n` +
    item.prompt
  );
}

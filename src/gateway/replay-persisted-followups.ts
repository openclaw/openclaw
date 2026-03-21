import {
  consumeDrainRejectedMessages,
  consumePersistedFollowups,
  type PersistedFollowupItem,
} from "../auto-reply/reply/queue/persist.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";

/**
 * Replay persisted followup queue items and drain-rejected messages after
 * gateway restart.
 *
 * Injects persisted messages as system events on the relevant sessions.
 * They will be included in the next agent turn (heartbeat, new message,
 * or cron) so the agent can see and respond to them.
 *
 * Phase 1: followup queue items (persisted during orderly shutdown).
 * Phase 2: drain-rejected messages (persisted when GatewayDrainingError
 *          rejected inbound dispatch during the drain window).
 */
export async function replayPersistedFollowups(): Promise<void> {
  let replayed = 0;

  // Phase 1: followup queue items
  const queues = await consumePersistedFollowups();
  for (const queue of queues) {
    for (const item of queue.items) {
      if (!item.sessionKey) {
        defaultRuntime.warn?.(
          `Skipping persisted followup with no sessionKey (queue: ${queue.queueKey})`,
        );
        continue;
      }
      const text = formatReplayedMessage(item, "queued");
      enqueueSystemEvent(text, { sessionKey: item.sessionKey });
      replayed++;
    }
  }

  // Phase 2: drain-rejected inbound messages
  const drainRejected = await consumeDrainRejectedMessages();
  for (const item of drainRejected) {
    if (!item.sessionKey) {
      defaultRuntime.warn?.("Skipping drain-rejected message with no sessionKey");
      continue;
    }
    const text = formatReplayedMessage(item, "rejected during drain");
    enqueueSystemEvent(text, { sessionKey: item.sessionKey });
    replayed++;
  }

  if (replayed > 0) {
    defaultRuntime.info?.(`Injected ${replayed} persisted message(s) as system events for replay`);
  }
}

function formatReplayedMessage(item: PersistedFollowupItem, source: string): string {
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
    `[Replayed message — ${source} ${ageStr} before restart, from ${sender} via ${channel}]\n` +
    item.prompt
  );
}

import { consumePersistedQueues } from "../auto-reply/reply/queue/persist.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("pending-messages");

/**
 * On startup after a restart, check for persisted pending messages and
 * inject them as system events into the relevant sessions so the agent
 * can process them on the next turn.
 */
export async function replayPersistedPendingMessages(): Promise<void> {
  const entries = await consumePersistedQueues();
  if (!entries || entries.length === 0) {
    return;
  }

  let totalReplayed = 0;

  for (const entry of entries) {
    if (!entry.items || entry.items.length === 0) {
      continue;
    }

    // The queue key is typically the session key
    const sessionKey = entry.key;

    // Build a summary of the missed messages
    const messageLines = entry.items.map((item, i) => {
      const sender = item.run?.senderName || item.run?.senderId || "unknown";
      const channel = item.originatingChannel || "unknown";
      const text = item.prompt.length > 500 ? `${item.prompt.slice(0, 500)}…` : item.prompt;
      return `${i + 1}. [${channel}] from ${sender}: ${text}`;
    });

    const eventText = [
      `⚠️ Gateway restart recovery: ${entry.items.length} message(s) were queued when the gateway restarted and may not have been processed:`,
      ...messageLines,
      "",
      "These messages were received but the gateway restarted before they could be fully processed. Please review and respond if needed.",
    ].join("\n");

    try {
      enqueueSystemEvent(eventText, {
        sessionKey,
        contextKey: "restart-pending-messages",
      });
      totalReplayed += entry.items.length;
    } catch (err) {
      log.warn(`failed to inject pending messages for session ${sessionKey}: ${String(err)}`);
    }
  }

  if (totalReplayed > 0) {
    log.info(
      `injected ${totalReplayed} pending message(s) as system events for post-restart replay`,
    );
  }
}

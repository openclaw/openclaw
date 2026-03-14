import { FOLLOWUP_QUEUES } from "./state.js";

/**
 * Wait for all followup queues to finish draining, up to `timeoutMs`.
 * Returns `{ drained: true }` if all queues are empty, or `{ drained: false }`
 * if the timeout was reached with items still pending.
 *
 * Called during SIGUSR1 restart after flushing inbound debouncers, so the
 * newly enqueued items have time to be processed before the server tears down.
 */
export async function waitForFollowupQueueDrain(
  timeoutMs: number,
): Promise<{ drained: boolean; remaining: number }> {
  const deadline = Date.now() + timeoutMs;
  const POLL_INTERVAL_MS = 50;

  const getPendingCount = (): number => {
    let total = 0;
    for (const queue of FOLLOWUP_QUEUES.values()) {
      total += queue.items.length;
      if (queue.draining) {
        // Count draining queues as having at least 1 pending item so we keep
        // waiting for the drain loop to finish even if items.length hits 0
        // momentarily between shifts.
        total = Math.max(total, 1);
      }
    }
    return total;
  };

  let remaining = getPendingCount();
  if (remaining === 0) {
    return { drained: true, remaining: 0 };
  }

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
      timer.unref?.();
    });
    remaining = getPendingCount();
    if (remaining === 0) {
      return { drained: true, remaining: 0 };
    }
  }

  return { drained: false, remaining };
}

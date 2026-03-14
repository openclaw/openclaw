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
      // Add 1 for the in-flight item owned by an active drain loop.
      const queuePending = queue.items.length + (queue.draining ? 1 : 0);
      total += queuePending;
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

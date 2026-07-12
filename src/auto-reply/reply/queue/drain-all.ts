// Waits for all process-wide followup queues to finish queued and summary work.
import { FOLLOWUP_QUEUES } from "./state.js";

function getPendingFollowupCount(): number {
  let pending = 0;
  for (const queue of FOLLOWUP_QUEUES.values()) {
    pending += queue.items.length + queue.droppedCount + (queue.draining ? 1 : 0);
  }
  return pending;
}

export async function waitForFollowupQueueDrain(
  timeoutMs?: number,
): Promise<{ drained: boolean; remaining: number }> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const remaining = getPendingFollowupCount();
    if (remaining === 0) {
      return { drained: true, remaining: 0 };
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      return { drained: false, remaining };
    }
    await new Promise<void>((resolve) => {
      const delayMs =
        deadline === undefined ? 50 : Math.max(0, Math.min(50, deadline - Date.now()));
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
    });
  }
}

// Tracks core channel queue work that must settle before an in-process restart.
import { resolveGlobalMap } from "../shared/global-singleton.js";

type ChannelRunQueueHandle = {
  getPendingCount: () => number;
};

const CHANNEL_RUN_QUEUES = resolveGlobalMap<symbol, WeakRef<ChannelRunQueueHandle>>(
  Symbol.for("openclaw.channelRunQueues"),
);

export function registerChannelRunQueue(handle: ChannelRunQueueHandle): () => void {
  const key = Symbol();
  CHANNEL_RUN_QUEUES.set(key, new WeakRef(handle));
  return () => {
    // The returned lifecycle closure keeps the weakly registered handle live.
    void handle;
    CHANNEL_RUN_QUEUES.delete(key);
  };
}

function getPendingChannelRunQueueCount(): number {
  let pending = 0;
  for (const [key, reference] of CHANNEL_RUN_QUEUES) {
    const handle = reference.deref();
    if (!handle) {
      CHANNEL_RUN_QUEUES.delete(key);
      continue;
    }
    pending += handle.getPendingCount();
  }
  return pending;
}

export async function waitForChannelRunQueueDrain(
  timeoutMs?: number,
): Promise<{ drained: boolean; remaining: number }> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const remaining = getPendingChannelRunQueueCount();
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

/**
 * Global registry for tracking active reply dispatchers.
 * Used to ensure gateway restart waits for all replies to complete.
 */

type TrackedDispatcher = {
  readonly id: string;
  readonly pending: () => number;
  readonly waitForIdle: () => Promise<void>;
  readonly getSessionKey: () => string | undefined;
};

const activeDispatchers = new Set<TrackedDispatcher>();
let nextId = 0;

/**
 * Register a reply dispatcher for global tracking.
 * Returns an unregister function to call when the dispatcher is no longer needed.
 */
export function registerDispatcher(dispatcher: {
  readonly pending: () => number;
  readonly waitForIdle: () => Promise<void>;
  readonly getSessionKey?: () => string | undefined;
}): { id: string; unregister: () => void } {
  const id = `dispatcher-${++nextId}`;
  const tracked: TrackedDispatcher = {
    id,
    pending: dispatcher.pending,
    waitForIdle: dispatcher.waitForIdle,
    getSessionKey: dispatcher.getSessionKey ?? (() => undefined),
  };
  activeDispatchers.add(tracked);

  const unregister = () => {
    activeDispatchers.delete(tracked);
  };

  return { id, unregister };
}

/**
 * Get the total number of pending replies across all dispatchers.
 */
export function getTotalPendingReplies(): number {
  let total = 0;
  for (const dispatcher of activeDispatchers) {
    total += dispatcher.pending();
  }
  return total;
}

export async function waitForSessionDispatchIdle(sessionKey: string): Promise<void> {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return;
  }

  while (true) {
    const matching = [...activeDispatchers].filter(
      (dispatcher) => dispatcher.getSessionKey() === normalized && dispatcher.pending() > 0,
    );
    if (matching.length === 0) {
      return;
    }
    await Promise.allSettled(matching.map((dispatcher) => dispatcher.waitForIdle()));
  }
}

/**
 * Clear all registered dispatchers (for testing).
 * WARNING: Only use this in test cleanup!
 */
export function clearAllDispatchers(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error("clearAllDispatchers() is only available in test environments");
  }
  activeDispatchers.clear();
}

/**
 * Global registry for tracking active reply dispatchers.
 * Used to ensure gateway restart waits for all replies to complete.
 */

export type TrackedDispatcher = {
  readonly id: string;
  readonly pending: () => number;
  readonly waitForIdle: () => Promise<void>;
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
}): { id: string; unregister: () => void } {
  const id = `dispatcher-${++nextId}`;
  const tracked: TrackedDispatcher = {
    id,
    pending: dispatcher.pending,
    waitForIdle: dispatcher.waitForIdle,
  };
  activeDispatchers.add(tracked);

  const unregister = () => {
    activeDispatchers.delete(tracked);
  };

  return { id, unregister };
}

/**
 * Check if any registered dispatchers have pending replies.
 */
export function hasActiveDispatchers(): boolean {
  for (const dispatcher of activeDispatchers) {
    if (dispatcher.pending() > 0) {
      return true;
    }
  }
  return false;
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

/**
 * Wait for all registered dispatchers to become idle.
 */
export async function waitForAllDispatchersIdle(): Promise<void> {
  const dispatchers = Array.from(activeDispatchers);
  await Promise.all(dispatchers.map((d) => d.waitForIdle()));
}

/**
 * Get the count of registered dispatchers (for diagnostics).
 */
export function getDispatcherCount(): number {
  return activeDispatchers.size;
}

/**
 * Clear all registered dispatchers (for testing).
 * WARNING: Only use this in test cleanup!
 */
export function clearAllDispatchers(): void {
  activeDispatchers.clear();
}

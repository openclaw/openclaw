/**
 * Global registry for tracking active reply dispatchers.
 * Used to ensure gateway restart waits for all replies to complete.
 */
const activeDispatchers = new Set();
let nextId = 0;
/**
 * Register a reply dispatcher for global tracking.
 * Returns an unregister function to call when the dispatcher is no longer needed.
 */
export function registerDispatcher(dispatcher) {
    const id = `dispatcher-${++nextId}`;
    const tracked = {
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
 * Get the total number of pending replies across all dispatchers.
 */
export function getTotalPendingReplies() {
    let total = 0;
    for (const dispatcher of activeDispatchers) {
        total += dispatcher.pending();
    }
    return total;
}
/**
 * Clear all registered dispatchers (for testing).
 * WARNING: Only use this in test cleanup!
 */
export function clearAllDispatchers() {
    if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
        throw new Error("clearAllDispatchers() is only available in test environments");
    }
    activeDispatchers.clear();
}

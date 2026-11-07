/**
 * Global registry for tracking active reply dispatchers.
 * Used to ensure gateway restart waits for all replies to complete.
 */
import { resolveGlobalSet } from "../../shared/global-singleton.js";

type TrackedDispatcher = {
  pending: number;
};

const activeDispatchers = resolveGlobalSet<TrackedDispatcher>(
  Symbol.for("openclaw.activeReplyDispatchers"),
  "close-only",
);

/**
 * Returns an unregister function to call when the dispatcher is no longer needed.
 */
export function registerDispatcher(tracked: TrackedDispatcher): () => void {
  // Keep only the mutable count, never a closure over the turn's reply context.
  activeDispatchers.add(tracked);

  return () => {
    activeDispatchers.delete(tracked);
  };
}

export function getTotalPendingReplies(): number {
  let total = 0;
  for (const dispatcher of activeDispatchers) {
    total += dispatcher.pending;
  }
  return total;
}

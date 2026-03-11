import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();

/**
 * Mutex-style lock that serializes operations across CronService instances sharing the same store.
 * Uses a deferred promise pattern that sets the lock BEFORE awaiting the previous lock,
 * ensuring all subsequent callers wait even if they arrive before the previous operation starts.
 */
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;

  // Capture the previous lock (or a resolved promise if none exists)
  const previousStoreLock = storeLocks.get(storePath) ?? Promise.resolve();
  const previousInstanceOp = state.op;

  // Create deferred promises for this operation - resolved when we're done
  let resolveStoreLock!: () => void;
  const thisStoreLock = new Promise<void>((resolve) => {
    resolveStoreLock = resolve;
  });

  let resolveInstanceOp!: () => void;
  const thisInstanceOp = new Promise<void>((resolve) => {
    resolveInstanceOp = resolve;
  });

  // Set the new locks BEFORE waiting for the previous locks.
  // This ensures any subsequent caller will wait for us, even if we haven't started yet.
  storeLocks.set(storePath, thisStoreLock);
  state.op = thisInstanceOp;

  try {
    // Wait for both previous locks to complete (ignoring errors)
    await Promise.all([previousStoreLock.catch(() => {}), previousInstanceOp.catch(() => {})]);

    // Execute the critical section
    return await fn();
  } finally {
    // Release both locks
    resolveStoreLock();
    resolveInstanceOp();
  }
}

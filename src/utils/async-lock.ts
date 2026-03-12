/**
 * Creates an asynchronous lock that ensures only one async operation
 * executes at a time while others wait.
 * @returns A function that accepts an async function and runs it in sequence
 */
export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();

  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Wait for the previous lock to complete
    const previousLock = lock;
    let release!: () => void; // Use definite assignment assertion

    // Create a new lock that will be released when the function completes
    lock = new Promise((resolve) => {
      release = resolve;
    });

    // Wait for the previous lock to complete before starting
    await previousLock;

    try {
      // Execute the function while holding the lock
      const result = await fn();
      return result;
    } finally {
      // Release the current lock
      release();
    }
  };
}

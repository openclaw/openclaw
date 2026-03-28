/**
 * Wrap a Promise with a hard deadline.
 *
 * Rejects with `Error("timeout")` if the wrapped promise does not settle
 * within `timeoutMs` milliseconds.  The timer is always cleared in .finally()
 * so it cannot hold the Node.js event loop open after the race is decided.
 *
 * Fast path: returns the original promise unchanged when timeoutMs <= 0.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

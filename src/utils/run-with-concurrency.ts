/**
 * Bounded concurrency scheduler.
 *
 * Runs up to `limit` tasks simultaneously, preserving result order.
 *
 * Algorithm (worker-pool pattern):
 *   Spawn exactly min(limit, tasks.length) worker coroutines.  Each worker
 *   atomically claims the next task index via a shared counter and loops
 *   until all tasks are exhausted.  Because JavaScript is single-threaded,
 *   the `next++` increment is race-free without a mutex.
 *
 * Complexity: O(n) time, O(limit) space for the worker coroutines.
 * No priority queue, no semaphore, no external dependencies.
 */

export type ConcurrencyErrorMode = "continue" | "stop";

export async function runTasksWithConcurrency<T>(params: {
  tasks: Array<() => Promise<T>>;
  limit: number;
  errorMode?: ConcurrencyErrorMode;
  onTaskError?: (error: unknown, index: number) => void;
}): Promise<{ results: T[]; firstError: unknown; hasError: boolean }> {
  const { tasks, limit, onTaskError } = params;
  const errorMode = params.errorMode ?? "continue";

  if (tasks.length === 0) {
    return { results: [], firstError: undefined, hasError: false };
  }

  // Cap worker count to actual task count — no idle workers.
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  // Pre-allocate results array to avoid dynamic resizing.
  // Array.from({length}) is the project-preferred idiom (unicorn/no-new-array).
  const results: T[] = Array.from({ length: tasks.length }) as T[];
  let next = 0;
  let firstError: unknown = undefined;
  let hasError = false;

  // Each worker is a self-contained async loop — no shared queue object,
  // no heap allocation per task beyond the task's own Promise.
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      // In "stop" mode, bail out as soon as any worker has recorded an error.
      if (errorMode === "stop" && hasError) {
        return;
      }

      // Claim the next task index atomically (safe: JS is single-threaded).
      const index = next++;
      if (index >= tasks.length) {
        return;
      }

      try {
        results[index] = await tasks[index]();
      } catch (error) {
        // Record only the first error; subsequent errors are still reported
        // via onTaskError but do not overwrite firstError.
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
        onTaskError?.(error, index);
        if (errorMode === "stop") {
          return;
        }
      }
    }
  });

  // allSettled: we never reject the outer promise — errors are captured above.
  await Promise.allSettled(workers);
  return { results, firstError, hasError };
}

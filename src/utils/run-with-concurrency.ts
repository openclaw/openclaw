/** Controls whether the worker pool keeps scheduling after a task failure. */
export type ConcurrencyErrorMode = "continue" | "stop";

/** Runs async tasks with bounded concurrency while preserving result indexes. */
export async function runTasksWithConcurrency<T>(params: {
  /** Task factories run lazily by the worker pool. */
  tasks: Array<() => Promise<T>>;
  /** Maximum concurrent workers; values below one are coerced to one. */
  limit: number;
  /** stop prevents new tasks after the first failure; continue keeps draining. */
  errorMode?: ConcurrencyErrorMode;
  /** Per-task error hook called with the original task index. */
  onTaskError?: (error: unknown, index: number) => void;
}): Promise<{
  /** Sparse result array aligned with the original task indexes. */
  results: T[];
  /** First thrown error by task order of observation, not necessarily task index. */
  firstError: unknown;
  /** True when at least one task rejected. */
  hasError: boolean;
}> {
  const { tasks, limit, onTaskError } = params;
  const errorMode = params.errorMode ?? "continue";
  if (tasks.length === 0) {
    return { results: [], firstError: undefined, hasError: false };
  }

  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let firstError: unknown = undefined;
  let hasError = false;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (errorMode === "stop" && hasError) {
        return;
      }
      // Claim indexes synchronously before awaiting so workers never run the
      // same task, while completed results still write back to original slots.
      const index = next;
      next += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]();
      } catch (error) {
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

  await Promise.allSettled(workers);
  return { results, firstError, hasError };
}

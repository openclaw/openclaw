import { logVerbose, shouldLogVerbose } from "../globals.js";

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        if (shouldLogVerbose()) {
          logVerbose(`Media understanding task failed: ${String(err)}`);
        }
      }
    }
  });

  await Promise.allSettled(workers);
  return results;
}

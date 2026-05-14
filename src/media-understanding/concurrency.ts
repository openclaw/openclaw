import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const { results } = await runTasksWithConcurrency({
    tasks,
    limit,
    onTaskError(err) {
      if (shouldLogVerbose()) {
        logVerbose(`Media understanding task failed: ${String(err)}`);
      }
    },
  });
  return results;
}

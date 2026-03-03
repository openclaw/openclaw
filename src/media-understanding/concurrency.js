import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
export async function runWithConcurrency(tasks, limit) {
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

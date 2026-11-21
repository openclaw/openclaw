import { isMainThread } from "node:worker_threads";
import { withConsoleLogsRoutedToStderrForJson } from "../cli/json-output-mode.js";
import { drainProcessOutput } from "../process/output-drain.js";
import { resolveSqliteInspectionBudget } from "./sqlite-readonly-worker.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import { serveWorkerTasks } from "./worker-task-server.js";

if (isMainThread) {
  const pool = new WorkerTaskPool<null, { value: string }>({
    workerUrl: new URL(import.meta.url),
    maxWorkers: 1,
  });
  try {
    await withConsoleLogsRoutedToStderrForJson(
      [],
      async () => {
        const result = await pool.run(null, {});
        process.stdout.write(`${JSON.stringify(result)}\n`);
      },
      { machineOutput: true, retainRoutingUntilProcessExit: true },
    );
  } finally {
    await pool.close();
  }
} else {
  serveWorkerTasks(async () => {
    resolveSqliteInspectionBudget("read-only snapshot", "synthetic.sqlite", 4096n);
    // The pool may terminate after the reply; prove the diagnostic reached its pipe first.
    await new Promise<void>(drainProcessOutput);
    return { value: "ready" };
  });
}

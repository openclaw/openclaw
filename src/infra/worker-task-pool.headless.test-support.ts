import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "./worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
  workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
});
console.log((await pool.run({ label: "finished" }, { timeoutMs: 10_000 })).label);

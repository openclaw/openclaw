import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { WorkerTaskError, WorkerTaskPool } from "./worker-task-pool.js";

for (const failure of ["exit", "oom"] as const) {
  const script = `
    import { parentPort } from "node:worker_threads";
    parentPort.once("message", () => {
      ${
        failure === "exit"
          ? "process.exit(77);"
          : `
        const allocations = [];
        for (;;) allocations.push(new Array(131072).fill(allocations.length));
      `
      }
    });
  `;
  const pool = new WorkerTaskPool<{ label: string }, unknown>({
    workerUrl: new URL(`data:text/javascript,${encodeURIComponent(script)}`),
    workerOptions: {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
    },
    maxWorkers: 2,
    restartOnError: false,
  });
  const unhandled: unknown[] = [];
  const observeUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", observeUnhandled);
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, index) =>
        pool.run({ label: `caller-${index}` }, { timeoutMs: 10_000 }),
      ),
    );
    await pool.close();
    await setImmediate();
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof WorkerTaskError);
        assert.equal(result.reason.code, "unavailable");
        assert.ok(
          result.reason.message.includes(
            failure === "exit" ? "worker exited with code 77" : "ERR_WORKER_OUT_OF_MEMORY",
          ),
        );
      }
    }
    assert.deepEqual(unhandled, []);
  } finally {
    await pool.close();
    process.off("unhandledRejection", observeUnhandled);
  }
}

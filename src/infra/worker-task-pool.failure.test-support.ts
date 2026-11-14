import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WorkerTaskError, WorkerTaskPool } from "./worker-task-pool.js";

// Attribute known tasks without publishing source paths or arbitrary input labels.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-task-attribution-"));
const workerPath = path.join(directory, "manager-index.worker.mjs");
await fs.writeFile(
  workerPath,
  `
  import { parentPort, workerData } from "node:worker_threads";
  function fail() {
    if (workerData.failure === "exit") process.exit(77);
    const allocations = [];
    for (;;) allocations.push(new Array(131072).fill(allocations.length));
  }
  parentPort.once("message", ({ taskId }) => {
    if (!workerData.exchange) return fail();
    parentPort.postMessage({ status: "request", taskId, id: 1, value: null });
    parentPort.once("message", () => {
      parentPort.postMessage({ status: "consumed", taskId, id: 1 });
      fail();
    });
  });
`,
);
try {
  for (const [failure, kind] of [
    ["exit", undefined],
    ["oom", undefined],
    ["oom", "prepare-session"],
    ["oom", "private-input-secret"],
  ] as const) {
    const pool = new WorkerTaskPool<{ label: string } | { kind: string; content: string }, unknown>(
      {
        workerUrl: pathToFileURL(workerPath),
        workerOptions: {
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
          workerData: { failure, exchange: Boolean(kind) },
        },
        maxWorkers: kind ? 1 : 2,
        restartOnError: kind ? undefined : false,
      },
    );
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      const results = await Promise.allSettled(
        Array.from({ length: kind ? 1 : 40 }, (_, index) =>
          pool.run(
            kind
              ? () => ({ kind, content: "private-transcript-secret" })
              : { label: `caller-${index}` },
            {
              ...(kind
                ? { inputBytes: 1234, onRequest: async () => ({ input: null, timeoutMs: 10_000 }) }
                : {}),
              timeoutMs: 10_000,
            },
          ),
        ),
      );
      await pool.close();
      await setImmediate();
      for (const result of results) {
        assert.ok(result.status === "rejected");
        const error = result.reason;
        assert.ok(error instanceof WorkerTaskError);
        assert.equal(error.code, "unavailable");
        assert.ok(
          error.message.includes(
            failure === "exit" ? "worker exited with code 77" : "ERR_WORKER_OUT_OF_MEMORY",
          ),
        );
        if (kind) {
          assert.ok(error.cause instanceof Error);
          assert.equal(Reflect.get(error.cause, "code"), "ERR_WORKER_OUT_OF_MEMORY");
          assert.ok(
            error.message.includes(
              `task=memoryIndex.${kind === "prepare-session" ? kind : "task"}`,
            ),
          );
          assert.match(
            error.message,
            /admittedInputBytes=1234 exchanges=1 stage=(running|exchange)/,
          );
          assert.ok(!error.message.includes(directory));
          assert.ok(!error.message.includes("private-input-secret"));
          assert.ok(!error.message.includes("private-transcript-secret"));
        }
      }
      assert.deepEqual(unhandled, []);
      assert.equal(pool.getSnapshot().pendingTasks, 0);
    } finally {
      await pool.close();
      process.off("unhandledRejection", observeUnhandled);
    }
  }
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

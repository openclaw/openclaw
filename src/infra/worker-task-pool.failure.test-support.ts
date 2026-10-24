import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
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

// Attribute known tasks without publishing source paths or arbitrary input labels.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-task-attribution-"));
const workerPath = path.join(directory, "manager-index.worker.mjs");
await fs.writeFile(
  workerPath,
  `
  import { parentPort } from "node:worker_threads";
  parentPort.once("message", ({ taskId }) => {
    parentPort.postMessage({ status: "request", taskId, id: 1, value: null });
    parentPort.once("message", () => {
      parentPort.postMessage({ status: "consumed", taskId, id: 1 });
      const allocations = [];
      for (;;) allocations.push(new Array(131072).fill(allocations.length));
    });
  });
`,
);
try {
  for (const kind of ["prepare-session", "private-input-secret"]) {
    const pool = new WorkerTaskPool<{ kind: string; content: string }, unknown>({
      workerUrl: pathToFileURL(workerPath),
      workerOptions: {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
      },
      maxWorkers: 1,
    });
    try {
      await assert.rejects(
        pool.run(() => ({ kind, content: "private-transcript-secret" }), {
          inputBytes: 1234,
          timeoutMs: 10_000,
          onRequest: async () => ({ input: null, timeoutMs: 10_000 }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof WorkerTaskError);
          assert.equal(error.code, "unavailable");
          assert.ok(error.cause instanceof Error);
          assert.equal(Reflect.get(error.cause, "code"), "ERR_WORKER_OUT_OF_MEMORY");
          assert.match(error.message, /ERR_WORKER_OUT_OF_MEMORY/);
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
          return true;
        },
      );
      assert.equal(pool.getSnapshot().pendingTasks, 0);
    } finally {
      await pool.close();
    }
  }
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

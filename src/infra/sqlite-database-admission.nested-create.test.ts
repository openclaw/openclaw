import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  nextEventLoopTurn,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import * as databaseAdmission from "./sqlite-database-admission.js";
import type {
  AdmissionTaskInput,
  AdmissionTaskResult,
} from "./sqlite-database-admission.task.test-support.js";
import { holdCreatedFileCallback } from "./sqlite-worker-fixture.test-support.js";
import * as workerIdentity from "./sqlite-worker-identity.js";
import * as operationAdmission from "./sqlite-worker-operation-admission.js";
import * as nativeLifetime from "./worker-native-lifecycle.js";
import * as taskHost from "./worker-task-host.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const workerUrl = new URL("./sqlite-database-admission.task.test-support.ts", import.meta.url);

function createPool() {
  return createOwnedWorkerTaskPool<AdmissionTaskInput, AdmissionTaskResult>(
    { workerUrl, maxWorkers: 1, idleTimeoutMs: 0 },
    { retainedTransport: true },
  );
}

it.for(["event", "pump"] as const)(
  "nested broker creation performs no main-thread Sync FS through %s delivery and cleanup",
  async (mode, { signal }) => {
    const databasePath = path.join(directories.make("nested-create-owner-"), "created.sqlite");
    const pool = createPool();
    const gate = new Int32Array(new SharedArrayBuffer(8));
    const tick = new Int32Array(new SharedArrayBuffer(4));
    const prepare = databaseAdmission.prepareSqliteDatabaseAdmissionAsync;
    const calls: string[] = [];
    using preparation = vi.spyOn(databaseAdmission, "prepareSqliteDatabaseAdmissionAsync");
    preparation.mockImplementation((params) => {
      if (params.location === databasePath) {
        calls.push(new Error().stack ?? "");
      }
      return prepare(params);
    });
    const observed = observeMainThreadFs();
    try {
      const task = pool.startTask(
        {
          path: databasePath,
          nested: true,
          broker: true,
          writeProof: true,
          ...(mode === "pump" ? { createPumpGate: gate.buffer } : {}),
        },
        {},
      );
      void task.result.catch(() => {});
      try {
        if (mode === "pump") {
          await withinTest(Promise.resolve(Atomics.waitAsync(gate, 0, 0, 10_000).value), signal);
          expect(Atomics.load(gate, 0)).toBe(1);
          Atomics.store(gate, 1, 1);
          Atomics.notify(gate, 1);
          const deadline = performance.now() + 10_000;
          while (
            calls.length === 0 &&
            task.read().status === "pending" &&
            performance.now() < deadline
          ) {
            task.service();
            if (calls.length === 0) {
              Atomics.wait(tick, 0, 0, 2);
            }
          }
          expect(calls.some((stack) => stack.includes("serviceNativeWorkers"))).toBe(true);
        }
        const reply = await withinTest(task.result, signal);
        expect(reply.threadId).toBeGreaterThan(0);
        expect(reply.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
      } finally {
        Atomics.store(gate, 1, 1);
        Atomics.notify(gate, 1);
        await task.release({ retire: true }).result;
      }
      await pool.close();
      expect(observed.calls()).toEqual({});
    } finally {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      await pool.close();
      observed[Symbol.dispose]();
    }
    using database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT value FROM nested_creation_proof").all()).toEqual([
      { value: 42 },
    ]);
  },
);

it("refuses nested creation when its actual task relay retires during physical preparation", async ({
  signal,
}) => {
  const databasePath = path.join(directories.make("nested-create-refused-"), "created.sqlite");
  const inspecting = createEnteredGate();
  let held = false;
  const inspect = workerIdentity.inspectDatabasePathIdentity;
  using inspection = vi.spyOn(workerIdentity, "inspectDatabasePathIdentity");
  inspection.mockImplementation(async (...args) => {
    const result = await inspect(...args);
    if (args[0] === databasePath && !held) {
      held = true;
      await inspecting.wait();
    }
    return result;
  });
  const relayRefused = vi.fn();
  const createRelay = operationAdmission.createSqliteDatabaseAdmissionRelay;
  using relayCapture = vi.spyOn(operationAdmission, "createSqliteDatabaseAdmissionRelay");
  relayCapture.mockImplementation((assertCurrent) =>
    createRelay(() => {
      try {
        assertCurrent();
      } catch (error) {
        relayRefused(error);
        throw error;
      }
    }),
  );
  const createHost = taskHost.createWorkerTaskHost;
  let host: ReturnType<typeof createHost> | undefined;
  using hostCapture = vi.spyOn(taskHost, "createWorkerTaskHost");
  hostCapture.mockImplementation((...args) => {
    host = createHost(...args);
    return host;
  });
  const createWorker = nativeLifetime.createRetainedNativeWorker;
  let worker: ReturnType<typeof createWorker> | undefined;
  using workerCapture = vi.spyOn(nativeLifetime, "createRetainedNativeWorker");
  workerCapture.mockImplementation((...args) => {
    const created = createWorker(...args);
    if (String(args[0]) === String(workerUrl)) {
      worker = created;
    }
    return created;
  });
  const pool = createPool();
  const result = pool.run({ path: databasePath, nested: true, broker: true, writeProof: true }, {});
  const outcome = Promise.allSettled([result]);
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        inspecting.entered,
        result,
        "Nested creation bypassed async qualification",
      ),
      signal,
    );
    assert(host && worker, "Expected the actual host and outer task worker");
    // Retire the real owner while leaving the native request waiting; cancellation alone would only test assertWaiting.
    host.workerRetiring(worker, "closed");
    inspecting.release();
    await withinTest(outcome, signal);
    await expect(result).rejects.toThrow("SQLite admission facts exchange failed");
    expect(relayRefused).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "SQLite creation relay's task worker is retiring",
      }),
    );
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    inspecting.release();
    await outcome;
    await pool.close();
  }
});

it.for(["queued work", "pool close"] as const)(
  "joins nested accepted creation after real worker exit before releasing %s",
  async (mode, { signal }) => {
    const databasePath = path.join(directories.make("nested-create-exit-"), "created.sqlite");
    using creation = holdCreatedFileCallback(databasePath);
    const createWorker = nativeLifetime.createRetainedNativeWorker;
    let worker: ReturnType<typeof createWorker> | undefined;
    using workerCapture = vi.spyOn(nativeLifetime, "createRetainedNativeWorker");
    workerCapture.mockImplementation((...args) => {
      const created = createWorker(...args);
      if (String(args[0]) === String(workerUrl)) {
        worker = created;
      }
      return created;
    });
    const pool = createPool();
    // Unowned run retains its actual completion in the retiring slot; owned task.result intentionally rejects early.
    const result = pool.run(
      { path: databasePath, nested: true, broker: true, writeProof: true },
      {},
    );
    const completed = vi.fn();
    const outcome = Promise.allSettled([result]).then((value) => {
      completed();
      return value;
    });
    let next: Promise<AdmissionTaskResult> | undefined;
    let closing: Promise<void> | undefined;
    const nextCompleted = vi.fn();
    const closed = vi.fn();
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          creation.entered,
          result,
          "Nested creation bypassed callback descriptor ownership",
        ),
        signal,
      );
      expect((await fs.stat(databasePath)).size).toBe(0);
      assert(worker, "Expected the actual creating outer worker");
      const creatingWorker = worker;
      const stopped = new Promise<void>((resolve) => {
        creatingWorker.once("exit", () => resolve());
      });
      if (mode === "queued work") {
        next = pool.run({}, {}).then((value) => {
          nextCompleted();
          return value;
        });
        void next.catch(() => {});
      }
      await withinTest(creatingWorker.terminate(), signal);
      await withinTest(stopped, signal);
      await nextEventLoopTurn();
      expect(completed).not.toHaveBeenCalled();
      expect(pool.getSnapshot().workersCreated).toBe(1);
      expect(pool.getSnapshot().pendingTasks).toBe(mode === "queued work" ? 2 : 1);
      expect(nextCompleted).not.toHaveBeenCalled();
      if (mode === "pool close") {
        closing = pool.close().then(closed);
        await nextEventLoopTurn();
        expect(closed).not.toHaveBeenCalled();
      }
      creation.release();
      expect((await withinTest(outcome, signal))[0]).toMatchObject({ status: "rejected" });
      if (next) {
        expect((await withinTest(next, signal)).threadId).toBeGreaterThan(0);
        expect(nextCompleted).toHaveBeenCalledOnce();
        expect(pool.getSnapshot().workersCreated).toBe(2);
      }
      await withinTest(closing ?? pool.close(), signal);
      expect(completed).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      expect((await fs.stat(databasePath)).size).toBe(0);
    } finally {
      creation.release();
      await outcome;
      if (next) {
        await Promise.allSettled([next]);
      }
      await (closing ?? pool.close());
    }
  },
);

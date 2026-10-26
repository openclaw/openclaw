import fs from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as snapshots from "../infra/sqlite-readonly-location-cleanup.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { installCronSnapshotFaults } from "./store.readonly-worker-faults.test-support.js";
import { withCronStore } from "./store.worker.test-support.js";
import { resolveCronStoreKeyAsync } from "./store/paths.js";

it.each(["worker", "snapshot"] as const)(
  "retains %s cleanup custody without losing a completed read",
  async (failureStage) => {
    await withCronStore(
      "cron-readonly-cleanup",
      async (state) => {
        await state.createDatabase();
        // Fault the dedicated cron reader after its separate binding selection.
        await resolveCronStoreKeyAsync(state.storePath, state.env);
        const failure = new Error("controlled worker retirement failure");
        const terminate = vi.spyOn(Worker.prototype, "terminate");
        const fault =
          failureStage === "snapshot" ? await installCronSnapshotFaults(state) : undefined;
        if (failureStage === "worker") {
          terminate.mockRejectedValueOnce(failure);
        }
        const closeSpy = vi.spyOn(WorkerTaskPool.prototype, "close");
        // Test cleanup must also reclaim the intentionally leaked pre-fix resources.
        const retainSpy = vi.spyOn(snapshots, "retainSnapshotTempDirectory");
        try {
          const reading = state.read(true);
          if (failureStage === "worker") {
            await expect(reading).rejects.toBe(failure);
          } else {
            expect((await reading).store.jobs).toEqual([]);
          }
          if (fault) {
            expect(fault.count("staging-rm")).toBeGreaterThan(0);
          }
          const directories = retainSpy.mock.calls.map(([directory]) => directory);
          expect(directories.length).toBeGreaterThan(0);
          if (failureStage === "worker") {
            await snapshots.cleanupSnapshotOperations();
          }
          await closeOpenClawStateDatabaseByPathAsync(state.statePath("unrelated.sqlite"));
          for (const retained of directories) {
            expect((await fs.stat(retained)).isDirectory()).toBe(true);
          }
          expect(terminate).toHaveBeenCalledTimes(1);

          fault?.allowRemoval();
          await state.close();
          await snapshots.cleanupSnapshotOperations();
          for (const retained of directories) {
            await expect(fs.stat(retained)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect((await state.read()).store.jobs).toEqual([]);
        } finally {
          terminate.mockRestore();
          fault?.allowRemoval();
          const pools = new Set(closeSpy.mock.contexts);
          closeSpy.mockRestore();
          try {
            for (const pool of pools) {
              assert(pool instanceof WorkerTaskPool);
              await pool.close();
            }
          } finally {
            for (const result of retainSpy.mock.results) {
              if (result.type === "return") {
                result.value();
              }
            }
            try {
              await snapshots.cleanupSnapshotOperations();
            } finally {
              retainSpy.mockRestore();
              fault?.restore();
            }
          }
        }
      },
      { XDG_CACHE_HOME: undefined },
    );
  },
);

it("refuses new reader admission while canonical close is draining an earlier reader", async () => {
  await withCronStore("cron-readonly-drain", async (state) => {
    await state.createDatabase();
    await resolveCronStoreKeyAsync(state.storePath, state.env);
    const entered = createDeferred();
    const finish = createDeferred();
    const draining = createDeferred();
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      async close() {
        draining.resolve();
      },
    });
    // oxlint-disable-next-line typescript/unbound-method -- call restores the intercepted worker receiver below.
    const terminate = Worker.prototype.terminate;
    const termination = vi
      .spyOn(Worker.prototype, "terminate")
      .mockImplementationOnce(async function (this: Worker) {
        entered.resolve();
        await finish.promise;
        return await terminate.call(this);
      });
    const first = state.read().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let closing: Promise<boolean> | undefined;
    try {
      await entered.promise;
      closing = state.close();
      await draining.promise;
      await expect(state.read()).rejects.toMatchObject({
        code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
      });
    } finally {
      finish.resolve();
      await closing;
      termination.mockRestore();
      unregister();
    }
    expect(await first).toMatchObject({ error: expect.any(Error) });
    expect((await state.read()).store.jobs).toEqual([]);
  });
});
import assert from "node:assert/strict";

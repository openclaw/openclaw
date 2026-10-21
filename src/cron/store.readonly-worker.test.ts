import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { collectLegacyCronStoreHealthFindings } from "../commands/doctor/cron/index.js";
import * as snapshots from "../infra/sqlite-readonly-location-cleanup.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronQuarantinedJobs } from "./store.js";
import { installCronSnapshotFaults } from "./store.readonly-worker-faults.test-support.js";
import { withCronStore } from "./store.worker.test-support.js";
import type { CronStoreFile } from "./types.js";

it.each([false, true])(
  "reports persisted quarantine through Doctor without caller-thread queries (cold=%s)",
  async (cold) => {
    await withCronStore("cron-quarantine-doctor", async (state) => {
      await saveCronQuarantinedJobs({
        storePath: resolveCronJobsStorePath(),
        entries: [{ sourceIndex: 0, reason: "missing-schedule", job: { id: "quarantined-job" } }],
        nowMs: 123,
      });
      if (cold) {
        await state.close();
      }
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        const findings = await collectLegacyCronStoreHealthFindings({ cfg: {} });
        expect(findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              requirement: "quarantined-cron-rows",
              message: expect.stringContaining("1 quarantined cron job row"),
            }),
          ]),
        );
        expect(observation.queries.filter((sql) => sql.includes('"diagnostic_events"'))).toEqual(
          [],
        );
      } finally {
        observation.restore();
      }
    });
  },
);

it.each([false, true])(
  "loads cold readonly cron state off the host with artifact preservation=%s",
  async (preserveArtifacts) => {
    await withCronStore("cron-readonly-worker", async (state) => {
      const store: CronStoreFile = {
        version: 1,
        jobs: [
          makeCronJob({
            name: "scheduled café 🦞",
            sessionTarget: "main",
            payload: { kind: "systemEvent", text: "persisted event" },
            state: { nextRunAtMs: 60_001 },
          }),
        ],
      };
      await state.save(store);
      await state.close();
      const before = await state.bytes();
      const sql = observeMainThreadSql({ includeClose: true });
      try {
        const loaded = await state.read(preserveArtifacts);
        expect(loaded.store).toEqual(store);
        expect(loaded.configJobIndexes).toEqual([0]);
        expect(loaded.configJobRuntimeEntries[0]?.state).toEqual({ nextRunAtMs: 60_001 });
        expect(loaded.jobsFingerprint).toBeUndefined();
        expect(loaded.invalidConfigRows).toEqual([]);
        sql.expectIdle();
        expect(await state.bytes()).toEqual(before);
      } finally {
        sql.restore();
      }
    });
  },
);

it("leaves missing databases absent and legacy layouts unmigrated", async () => {
  await withCronStore("cron-readonly-legacy", async (state) => {
    const databasePath = state.databasePath;
    const empty = await state.read();
    expect(empty.store).toEqual({ version: 1, jobs: [] });
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await state.createDatabase("CREATE TABLE legacy_marker(value TEXT); PRAGMA user_version = 1;");
    const before = await state.bytes();
    expect(await state.read(true)).toEqual(empty);
    expect(await state.bytes()).toEqual(before);
    expect(await state.read()).toEqual(empty);
    expect(await state.bytes()).toEqual(before);
  });
});

it("preserves native diagnostic errors without repairing an incompatible cron table", async () => {
  await withCronStore("cron-readonly-diagnostic", async (state) => {
    await state.createDatabase("CREATE TABLE cron_jobs(legacy_column TEXT)");
    const before = await state.bytes();
    await expect(state.read()).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
      message: expect.stringContaining("no such column"),
    });
    expect(await state.bytes()).toEqual(before);
  });
});

it.each(["worker", "snapshot"] as const)(
  "retains %s cleanup custody without losing a completed read",
  async (failureStage) => {
    await withCronStore(
      "cron-readonly-cleanup",
      async (state) => {
        await state.createDatabase();
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
          expect(terminate).toHaveBeenCalledTimes(failureStage === "worker" ? 2 : 1);
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

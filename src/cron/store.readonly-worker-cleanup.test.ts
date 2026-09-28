import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as snapshots from "../infra/sqlite-readonly-location-cleanup.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "./store.js";

it.each(["worker", "snapshot"] as const)(
  "retries failed %s cleanup through the canonical owner",
  async (failureStage) => {
    await withOpenClawTestState(
      { label: "cron-readonly-cleanup", env: { XDG_CACHE_HOME: undefined } },
      async (state) => {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        const db = new DatabaseSync(databasePath);
        db.exec("CREATE TABLE marker(value TEXT)");
        db.close();
        const failure = new Error("controlled worker retirement failure");
        const terminate = vi.spyOn(Worker.prototype, "terminate");
        const remove = vi.spyOn(fsSync.promises, "rm");
        if (failureStage === "worker") {
          terminate.mockRejectedValueOnce(failure);
        } else {
          remove.mockRejectedValueOnce(
            Object.assign(new Error("controlled snapshot removal failure"), { code: "EACCES" }),
          );
        }
        const pools = new Set<WorkerTaskPool<unknown, unknown>>();
        // oxlint-disable-next-line typescript/unbound-method -- call restores the intercepted pool receiver below.
        const close = WorkerTaskPool.prototype.close;
        const closeSpy = vi.spyOn(WorkerTaskPool.prototype, "close").mockImplementation(function (
          this: WorkerTaskPool<unknown, unknown>,
          error,
        ) {
          pools.add(this);
          return close.call(this, error);
        });
        // Test cleanup must also reclaim the intentionally leaked pre-fix resources.
        const readers: Array<() => void> = [];
        const directories: string[] = [];
        const retain = snapshots.retainSnapshotTempDirectory;
        const retainSpy = vi
          .spyOn(snapshots, "retainSnapshotTempDirectory")
          .mockImplementation((directory) => {
            const release = retain(directory);
            readers.push(release);
            directories.push(directory);
            return release;
          });
        try {
          const reading = withArtifactPreservingStateReads(() =>
            loadCronJobsStoreWithConfigJobsReadOnly(
              state.statePath("cron", "jobs.json"),
              state.env,
            ),
          );
          if (failureStage === "worker") {
            await expect(reading).rejects.toBe(failure);
          } else {
            await expect(reading).rejects.toThrow("Cron read-only state snapshot cleanup failed.");
          }
          expect(directories.length).toBeGreaterThan(0);
          if (failureStage === "worker") {
            await snapshots.cleanupSnapshotOperations();
          }
          await closeOpenClawStateDatabaseByPathAsync(state.statePath("unrelated.sqlite"));
          for (const retained of directories) {
            expect((await fs.stat(retained)).isDirectory()).toBe(true);
          }
          expect(terminate).toHaveBeenCalledTimes(1);

          await closeOpenClawStateDatabaseByPathAsync(databasePath);
          for (const retained of directories) {
            await expect(fs.stat(retained)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(terminate).toHaveBeenCalledTimes(failureStage === "worker" ? 2 : 1);
          const next = await loadCronJobsStoreWithConfigJobsReadOnly(
            state.statePath("cron", "jobs.json"),
            state.env,
          );
          expect(next.store.jobs).toEqual([]);
        } finally {
          terminate.mockRestore();
          remove.mockRestore();
          closeSpy.mockRestore();
          await Promise.all([...pools].map((pool) => pool.close()));
          for (const release of readers) {
            release();
          }
          await snapshots.cleanupSnapshotOperations();
          retainSpy.mockRestore();
        }
      },
    );
  },
);

it("refuses new reader admission while canonical close is draining an earlier reader", async () => {
  await withOpenClawTestState({ label: "cron-readonly-drain" }, async (state) => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE marker(value TEXT)");
    db.close();
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
    const read = () =>
      loadCronJobsStoreWithConfigJobsReadOnly(state.statePath("cron", "jobs.json"), state.env);
    const first = read().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let closing: Promise<boolean> | undefined;
    try {
      await entered.promise;
      closing = closeOpenClawStateDatabaseByPathAsync(databasePath);
      await draining.promise;
      await expect(read()).rejects.toMatchObject({
        code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
      });
    } finally {
      finish.resolve();
      await closing;
      termination.mockRestore();
      unregister();
    }
    expect(await first).toMatchObject({ error: expect.any(Error) });
    expect((await read()).store.jobs).toEqual([]);
  });
});

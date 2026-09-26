import { channel } from "node:diagnostics_channel";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
  withSessionHistoryBudgetSweepsForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import * as storeWriterQueue from "../../shared/store-writer-queue.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { drainSessionDiskBudgetWorkers } from "./disk-budget-runtime.js";
import {
  hasRetainedSessionTranscriptArchives,
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
} from "./disk-budget.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const workers: Worker[] = [];
const workerChannel = channel("worker_threads");
const trackWorker = (message: unknown) => workers.push((message as { worker: Worker }).worker);

beforeEach(() => workerChannel.subscribe(trackWorker));
afterEach(async () => {
  workerChannel.unsubscribe(trackWorker);
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

async function addSessionArtifacts(directory: string, index: number): Promise<void> {
  const hash = index.toString(16).padStart(64, "0");
  const blobDirectory = path.join(directory, "skills-prompts", "sha256", hash.slice(0, 2));
  await fs.mkdir(blobDirectory, { recursive: true });
  await fs.writeFile(path.join(directory, `session-${index}.jsonl`), Buffer.alloc(7));
  await fs.writeFile(path.join(blobDirectory, `${hash}.txt`), Buffer.alloc(11));
}

describe("physical session disk usage", () => {
  it.each([false, true])(
    "joins a forced followup after maintenance failure (mutation fails: %s)",
    async (mutationFails) => {
      await withTestDir({ prefix: "openclaw-maintenance-failure-drain-" }, async (directory) => {
        const storePath = path.join(directory, "openclaw-agent.sqlite");
        await fs.writeFile(storePath, Buffer.alloc(321));
        const failure = new Error("synthetic first scan preparation failure");
        const mutationFailure = new Error("synthetic mutation failure");
        const releaseFirst = createDeferredCore();
        const followupEntered = createDeferredCore();
        const releaseFollowup = createDeferredCore();
        const scans: Promise<unknown>[] = [];
        let followupFinished = false;
        let spy = vi.spyOn(WorkerTaskPool.prototype, "run");
        spy.mockImplementation(function trackRun(
          this: WorkerTaskPool<unknown, unknown>,
          input,
          options,
        ) {
          spy.mockRestore();
          const invoke = this.run.bind(this);
          spy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(trackRun);
          const first = scans.length === 0;
          const result = invoke(async () => {
            if (first) {
              await releaseFirst.promise;
              throw failure;
            }
            followupEntered.resolve();
            await releaseFollowup.promise;
            return input;
          }, options);
          const completion = first
            ? result
            : result.then(
                (value) => {
                  followupFinished = true;
                  return value;
                },
                (error: unknown) => {
                  followupFinished = true;
                  throw error;
                },
              );
          scans.push(completion);
          return completion;
        });
        const maintenanceConfig = resolveMaintenanceConfigFromInput({
          mode: "enforce",
          maxDiskBytes: 1024 * 1024,
          highWaterBytes: 512 * 1024,
        });
        const operation = withSessionHistoryBudgetSweepsForTest(async () => {
          kickSessionHistoryDiskBudgetMaintenance({ storePath, maintenanceConfig });
          kickSessionHistoryDiskBudgetMaintenance({ storePath, maintenanceConfig, force: true });
          releaseFirst.resolve();
          if (mutationFails) {
            throw mutationFailure;
          }
        });
        const outcome = operation.then(
          () => ({ error: undefined, followupFinished }),
          (error: unknown) => ({ error, followupFinished }),
        );
        try {
          await followupEntered.promise;
          releaseFollowup.resolve();
          const result = await outcome;
          if (mutationFails) {
            expect(result.error).toBeInstanceOf(AggregateError);
            expect(result.error).toHaveProperty("errors", [mutationFailure, failure]);
          } else {
            expect(result.error).toBe(failure);
          }
          expect(
            result.followupFinished,
            "Failure must not abandon already-started followup work",
          ).toBe(true);
          expect(scans).toHaveLength(2);
        } finally {
          releaseFirst.resolve();
          releaseFollowup.resolve();
          await outcome;
          await Promise.allSettled(scans);
          spy.mockRestore();
          await drainSessionDiskBudgetWorkers();
        }
      });
    },
  );

  it("joins real SDK mutation maintenance before native fixture drainage", async () => {
    const state = await createOpenClawTestState({ layout: "state-only" });
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const scope = { agentId: "main", env: state.env, storePath, sessionKey: "agent:main:fixture" };
    const releasePreparation = createDeferredCore();
    const mutationBodyFinished = createDeferredCore<boolean>();
    const secondScanAdmitted = createDeferredCore();
    const nativeRetired = createDeferredCore();
    const releaseRetirement = createDeferredCore();
    let scans = 0;
    let observedSdkSweeps = 0;
    let scanSpy = vi.spyOn(WorkerTaskPool.prototype, "run");
    scanSpy.mockImplementation(function trackScan(
      this: WorkerTaskPool<unknown, unknown>,
      input,
      options,
    ) {
      scanSpy.mockRestore();
      const invoke = this.run.bind(this);
      scanSpy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(trackScan);
      if (input !== storePath) {
        return invoke(input, options);
      }
      const scan = ++scans;
      const result = invoke(
        scan === 1
          ? async () => {
              await releasePreparation.promise;
              return input;
            }
          : input,
        options,
      );
      if (scan === 2) {
        secondScanAdmitted.resolve();
      }
      return result;
    });
    let retirement: MockInstance<Worker["terminate"]> | undefined;
    const diskWorkerUrl = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "disk-budget.worker",
      distWorkerPath: "config/sessions/disk-budget.worker.js",
    });
    const createWorker = workerCpu.createCpuTrackedWorker;
    const workerCreation = vi
      .spyOn(workerCpu, "createCpuTrackedWorker")
      .mockImplementation((filename, options) => {
        const worker = createWorker(filename, options);
        if (!retirement && String(filename) === diskWorkerUrl.href) {
          const terminate = worker.terminate.bind(worker);
          retirement = vi.spyOn(worker, "terminate").mockImplementationOnce(async () => {
            const code = await terminate();
            nativeRetired.resolve();
            await releaseRetirement.promise;
            return code;
          });
        }
        return worker;
      });
    const mutation = withSessionHistoryBudgetSweepsForTest(async () => {
      try {
        await upsertSessionEntry({
          ...scope,
          entry: { sessionId: "fixture-session", updatedAt: Date.now() },
        });
        expect(await deleteSessionEntry({ ...scope, expectedSessionId: "fixture-session" })).toBe(
          true,
        );
        expect(vi.isMockFunction(storeWriterQueue.runQueuedStoreWrite)).toBe(true);
        observedSdkSweeps = vi
          .mocked(storeWriterQueue.runQueuedStoreWrite)
          .mock.calls.filter(
            ([params]) => params.label === "enforceSqliteSessionHistoryDiskBudget",
          ).length;
        expect(
          observedSdkSweeps,
          "Actual SDK mutations must reach the canonical observed queue",
        ).toBeGreaterThan(0);
        expect(scans).toBe(1);
        mutationBodyFinished.resolve(true);
      } catch (error) {
        mutationBodyFinished.resolve(false);
        throw error;
      }
    });
    let drainage: Promise<void> | undefined;
    try {
      if (!(await mutationBodyFinished.promise)) {
        releasePreparation.resolve();
        await mutation;
      }
      drainage = (async () => {
        await mutation;
        await drainSessionDiskBudgetWorkers();
      })();
      releasePreparation.resolve();
      await Promise.all([nativeRetired.promise, secondScanAdmitted.promise]);
      releaseRetirement.resolve();
      await drainage;
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      const liveThreadIds = workers.map((worker) => worker.threadId).filter((id) => id !== -1);
      expect(scans).toBe(2);
      expect(liveThreadIds, "SDK fixture drainage must leave no live native worker").toEqual([]);
    } finally {
      releasePreparation.resolve();
      releaseRetirement.resolve();
      await Promise.allSettled([mutation, drainage]);
      retirement?.mockRestore();
      workerCreation.mockRestore();
      scanSpy.mockRestore();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      await drainSessionDiskBudgetWorkers();
      await state.cleanup();
    }
  });

  it("joins a measurement admitted after drainage starts before retiring its worker", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-drain-admission-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      await fs.writeFile(storePath, Buffer.alloc(321));
      const release = createDeferredCore();
      const spy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(function (
        this: WorkerTaskPool<unknown, unknown>,
        input,
        options,
      ) {
        spy.mockRestore();
        return this.run(async () => {
          await release.promise;
          return input;
        }, options);
      });
      let completed = 0;
      const first = measureSessionPhysicalDiskUsage(storePath).then(() => completed++);
      const drainage = drainSessionDiskBudgetWorkers();
      const late = measureSessionPhysicalDiskUsage(storePath).then(() => completed++);
      try {
        release.resolve();
        await drainage;
        expect(completed).toBe(2);
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBe(-1);
      } finally {
        release.resolve();
        spy.mockRestore();
        await Promise.allSettled([first, late, drainage]);
        await drainSessionDiskBudgetWorkers();
      }
    });
  });

  it.each([
    { owner: "file teardown", drain: drainSessionDiskBudgetWorkers },
    { owner: "runtime lifecycle cleanup", drain: drainGlobalSingletonLifecycleState },
  ])(
    "coalesces $owner with another teardown while a runtime scan awaits retirement",
    async ({ drain }) => {
      await withTestDir({ prefix: "openclaw-disk-usage-concurrent-drain-" }, async (directory) => {
        const storePath = path.join(directory, "openclaw-agent.sqlite");
        await fs.writeFile(storePath, Buffer.alloc(321));
        await measureSessionPhysicalDiskUsage(storePath);
        const retiringWorker = workers[0]!;
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const terminate = retiringWorker.terminate.bind(retiringWorker);
        // Observe the worker being drained; other pools may retire workers concurrently.
        const retirement = vi
          .spyOn(retiringWorker, "terminate")
          .mockImplementationOnce(async () => {
            const code = await terminate();
            entered.resolve();
            await release.promise;
            return code;
          });
        const firstDrain = drain();
        let secondDrain: Promise<void> | undefined;
        let measurement: ReturnType<typeof measureSessionPhysicalDiskUsage> | undefined;
        try {
          await entered.promise;
          let measured = false;
          measurement = measureSessionPhysicalDiskUsage(storePath).then((usage) => {
            measured = true;
            return usage;
          });
          secondDrain = drainSessionDiskBudgetWorkers();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(measured).toBe(false);
          expect(retiringWorker.threadId).toBe(-1);
          release.resolve();
          await Promise.all([firstDrain, secondDrain]);
          await expect(measurement).resolves.toMatchObject({ totalBytes: 321 });
          expect(retirement).toHaveBeenCalledTimes(1);
          expect(workers).toHaveLength(2);
          expect(workers[1]?.threadId).toBeGreaterThan(0);
        } finally {
          release.resolve();
          await Promise.allSettled([firstDrain, secondDrain, measurement]);
          retirement.mockRestore();
          await drainSessionDiskBudgetWorkers();
        }
      });
    },
  );

  it("reports scan overload and retires queued scans before reusing workers", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-pressure-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      const archivePath = path.join(directory, "old.jsonl.deleted.2026-01-01T00-00-00.000Z.zst");
      await fs.writeFile(storePath, Buffer.alloc(321));
      await fs.writeFile(archivePath, Buffer.alloc(100));
      const release = createDeferredCore();
      const spy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(function (
        this: WorkerTaskPool<unknown, unknown>,
        input,
        options,
      ) {
        spy.mockRestore();
        // Delay preparation, not the caller's result or the pool's capacity decision.
        return this.run(async () => {
          await release.promise;
          return input;
        }, options);
      });
      let settledScans = 0;
      const accepted = Array.from({ length: 128 }, () =>
        measureSessionPhysicalDiskUsage(storePath).then((usage) => {
          settledScans++;
          return usage;
        }),
      );
      let drainage: Promise<void> | undefined;
      let reported: unknown;
      const excess = measureSessionPhysicalDiskUsage(storePath).catch((error: unknown) => {
        reported = error;
      });
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(reported).toMatchObject({ name: "WorkerTaskError", code: "overloaded" });
        await expect(
          pruneSessionTranscriptArchivesToHighWater({ storePath, highWaterBytes: 321 }),
        ).rejects.toMatchObject({ code: "overloaded" });
        expect((await fs.stat(archivePath)).size).toBe(100);
        let drained = false;
        drainage = drainGlobalSingletonLifecycleState().then(() => {
          drained = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(drained).toBe(false);
        release.resolve();
        await drainage;
        expect(settledScans).toBe(128);
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBe(-1);
        const usage = {
          databaseMainBytes: 321,
          databaseWalBytes: 0,
          sessionFilesBytes: 100,
          totalBytes: 421,
        };
        expect(await Promise.all(accepted)).toEqual(Array.from({ length: 128 }, () => usage));
        await expect(
          pruneSessionTranscriptArchivesToHighWater({ storePath, highWaterBytes: 321 }),
        ).resolves.toMatchObject({ removedFiles: 1, usage: { totalBytes: 321 } });
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(workers).toHaveLength(2);
        expect(workers[1]?.threadId).toBeGreaterThan(0);
      } finally {
        release.resolve();
        spy.mockRestore();
        await Promise.allSettled([...accepted, excess]);
        await drainage;
      }
    });
  });

  it.each(["legacy", "sqlite", "legacy-in-agent"] as const)(
    "measures and prunes the canonical session artifacts through the %s selector",
    async (selector) => {
      await withTestDir({ prefix: "openclaw-disk-selector-" }, async (directory) => {
        const agentDir = path.join(directory, "agents", "main");
        const sessionsDir = path.join(agentDir, "sessions");
        const databasePath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        await fs.writeFile(databasePath, Buffer.alloc(321));
        await fs.writeFile(`${databasePath}-wal`, Buffer.alloc(654));
        await fs.writeFile(`${databasePath}-shm`, Buffer.alloc(32_768));
        await fs.writeFile(
          path.join(path.dirname(databasePath), "unrelated.txt"),
          Buffer.alloc(13),
        );
        await addSessionArtifacts(sessionsDir, 0);
        const archivePath = path.join(
          sessionsDir,
          "old.jsonl.deleted.2026-01-01T00-00-00.000Z.zst",
        );
        await fs.writeFile(archivePath, Buffer.alloc(100));
        const storePath = {
          legacy: path.join(sessionsDir, "sessions.json"),
          sqlite: databasePath,
          "legacy-in-agent": path.join(path.dirname(databasePath), "sessions.json"),
        }[selector];

        await expect(measureSessionPhysicalDiskUsage(storePath)).resolves.toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 118,
          totalBytes: 1_093,
        });
        await expect(hasRetainedSessionTranscriptArchives(storePath)).resolves.toBe(true);
        const pruned = await pruneSessionTranscriptArchivesToHighWater({
          storePath,
          highWaterBytes: 993,
        });
        expect(pruned).toMatchObject({
          removedFiles: 1,
          usage: { sessionFilesBytes: 18, totalBytes: 993 },
        });
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(hasRetainedSessionTranscriptArchives(storePath)).resolves.toBe(false);
      });
    },
  );

  it("propagates worker transport failure and measures successfully after recovery", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-worker-error-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      await fs.writeFile(storePath, Buffer.alloc(321));
      const send = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => {
        throw new Error("synthetic worker transport failure");
      });
      try {
        await expect(measureSessionPhysicalDiskUsage(storePath)).rejects.toMatchObject({
          code: "unavailable",
          message: expect.stringContaining("synthetic worker transport failure"),
        });
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBe(-1);
      } finally {
        send.mockRestore();
      }
      await expect(measureSessionPhysicalDiskUsage(storePath)).resolves.toEqual({
        databaseMainBytes: 321,
        databaseWalBytes: 0,
        sessionFilesBytes: 0,
        totalBytes: 321,
      });
      expect(workers).toHaveLength(2);
    });
  });

  it("propagates an unreadable custom-store inventory instead of reporting zero bytes", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-error-" }, async (directory) => {
      const notDirectory = path.join(directory, "not-a-directory");
      await fs.writeFile(notDirectory, "existing file");
      await expect(
        measureSessionPhysicalDiskUsage(path.join(notDirectory, "custom-store.json")),
      ).rejects.toMatchObject({
        code: "failed",
        message: expect.stringContaining("ENOTDIR"),
      });
    });
  });

  it("does not add synchronous realpath work as session artifacts grow", async () => {
    await withTestDir({ prefix: "openclaw-disk-scan-scaling-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      await fs.writeFile(storePath, Buffer.alloc(321));
      await fs.writeFile(`${storePath}-wal`, Buffer.alloc(654));
      await fs.writeFile(`${storePath}-shm`, Buffer.alloc(32_768));
      await addSessionArtifacts(directory, 0);
      const realpath = vi.spyOn(nodeFs, "realpathSync");
      const fixtureSyncCalls = () =>
        realpath.mock.calls.filter(
          ([candidate]) =>
            typeof candidate === "string" && candidate.startsWith(`${directory}${path.sep}`),
        ).length;
      try {
        const initial = await measureSessionPhysicalDiskUsage(storePath);
        const initialSyncCalls = fixtureSyncCalls();
        expect(initial).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 18,
          totalBytes: 993,
        });
        for (let index = 1; index <= 32; index += 1) {
          await addSessionArtifacts(directory, index);
        }
        realpath.mockClear();

        const expanded = await measureSessionPhysicalDiskUsage(storePath);
        const expandedSyncCalls = fixtureSyncCalls();

        expect(expanded).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 33 * 18,
          totalBytes: 975 + 33 * 18,
        });
        // Filesystem work that grows with the directory must not block the event loop.
        expect(expandedSyncCalls).toBeLessThanOrEqual(initialSyncCalls);
      } finally {
        realpath.mockRestore();
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "deduplicates SQLite aliases already counted through the sessions directory",
    async () => {
      await withTestDir({ prefix: "openclaw-disk-scan-alias-" }, async (directory) => {
        const sessionsDirectory = path.join(directory, "sessions-data");
        const aliasDirectory = path.join(directory, "sessions-alias");
        await fs.mkdir(sessionsDirectory);
        await fs.symlink(sessionsDirectory, aliasDirectory);
        const database = path.join(sessionsDirectory, "database.bin");
        const wal = path.join(sessionsDirectory, "wal.bin");
        await fs.writeFile(database, Buffer.alloc(321));
        await fs.writeFile(wal, Buffer.alloc(654));
        await fs.writeFile(path.join(sessionsDirectory, "active.jsonl"), Buffer.alloc(17));
        await fs.symlink(database, path.join(sessionsDirectory, "openclaw-agent.sqlite"));
        await fs.symlink(wal, path.join(sessionsDirectory, "openclaw-agent.sqlite-wal"));

        await addSessionArtifacts(sessionsDirectory, 0);
        await fs.writeFile(path.join(sessionsDirectory, "old.jsonl.migrated"), Buffer.alloc(4_096));

        const usage = await measureSessionPhysicalDiskUsage(
          path.join(aliasDirectory, "openclaw-agent.sqlite"),
        );

        expect(usage).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 35,
          totalBytes: 1_010,
        });
      });
    },
  );
});

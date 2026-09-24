import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CronService } from "./service.js";
import * as cronStore from "./store.js";
import {
  CronJobsStoreChangedError,
  getCronJobsStoreRevision,
  loadCronJobsStoreWithConfigJobs,
  noteCronJobsStoreCommit,
  saveCronJobsStore,
  saveCronJobsStoreChanges,
  saveCronJobsStoreWithRevision,
} from "./store.js";
import { restoreCronLoadError, serializeCronLoadError } from "./store/load-error.js";
import type { CronStoreWorkerOperations } from "./store/load-worker.types.js";
import { serializeCronSaveError } from "./store/save-error.js";
import type { CronStoreSaveWorkerOperations } from "./store/save-worker.types.js";
import type { CronJobCreate, CronStoreFile } from "./types.js";

function cronWorkerFixture(): CronStoreFile {
  return {
    version: 1,
    jobs: ["first", "second"].map((id) => ({
      id,
      name: id,
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "scheduled café 🦞" },
      state: { nextRunAtMs: 60_001 },
    })),
  };
}

it("loads complete partitioned cron state off the host and preserves it through reopen", async () => {
  await withOpenClawTestState({ label: "cron-worker-load" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const otherStorePath = state.statePath("other", "jobs.json");
    const store = cronWorkerFixture();
    await saveCronJobsStore(storePath, store);
    await saveCronJobsStore(otherStorePath, { version: 1, jobs: [] });
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    const revision = getCronJobsStoreRevision(storePath);
    const sql = observeMainThreadSql();
    try {
      const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(loaded.store.jobs.map((job) => job.id)).toEqual(["first", "second"]);
      expect(loaded.store.jobs[0]).toMatchObject(
        expectDefined(store.jobs[0], "first seeded cron job"),
      );
      expect(loaded.configJobs).toHaveLength(2);
      expect(loaded.configJobIndexes).toEqual([0, 1]);
      expect(loaded.configJobRuntimeEntries[0]?.state).toMatchObject({ nextRunAtMs: 60_001 });
      expect(loaded.jobsFingerprint).toEqual(expect.any(String));
      expect(loaded.invalidConfigRows).toEqual([]);
      expect((await loadCronJobsStoreWithConfigJobs(otherStorePath)).store.jobs).toEqual([]);
      expect(getCronJobsStoreRevision(storePath)).toBe(revision);
      sql.expectIdle();
      for (const job of store.jobs) {
        job.name = `updated ${job.id}`;
      }
      await saveCronJobsStore(storePath, store);
      sql.clear();
      const updated = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(updated.store.jobs.map((job) => job.name)).toEqual([
        "updated first",
        "updated second",
      ]);
      expect(updated.jobsFingerprint).not.toBe(loaded.jobsFingerprint);
      sql.expectIdle();
      // Canonical close joins database cleanup before the next read.
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      sql.clear();
      expect(await loadCronJobsStoreWithConfigJobs(storePath)).toEqual(updated);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

describe("worker load result publication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { ok: true, repairCommits: 2 },
    { ok: false, repairCommits: 2 },
    { ok: false, repairCommits: 0 },
  ])(
    "publishes completed or uncertain load repairs before settling success=$ok count=$repairCommits",
    async ({ ok, repairCommits }) => {
      const storePath = `/synthetic/cron-repair-result-${ok}-${repairCommits}/jobs.json`;
      const result: CronStoreWorkerOperations["cron.loadMutable"]["output"] = ok
        ? {
            ok: true,
            repairCommits,
            loaded: {
              store: { version: 1, jobs: [] },
              configJobs: [],
              configJobIndexes: [],
              configJobRuntimeEntries: [],
              invalidConfigRows: [],
            },
          }
        : {
            ok: false,
            repairCommits,
            error: { name: "Error", message: "later load stage failed", code: "SQLITE_ERROR" },
          };
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (_context, operation) => operation({ execute: vi.fn().mockResolvedValue(result) }),
      );
      noteCronJobsStoreCommit(storePath);
      const before = getCronJobsStoreRevision(storePath);
      if (ok) {
        await expect(loadCronJobsStoreWithConfigJobs(storePath)).resolves.toHaveProperty(
          "store.jobs",
          [],
        );
      } else {
        await expect(loadCronJobsStoreWithConfigJobs(storePath)).rejects.toMatchObject({
          message: "later load stage failed",
          code: "SQLITE_ERROR",
        });
      }
      expect(getCronJobsStoreRevision(storePath)).toBe(before + Math.max(1, repairCommits));
    },
  );

  it("invalidates a cached load when transport cannot provide its repair result", async () => {
    const storePath = "/synthetic/cron-unavailable-result/jobs.json";
    const failure = new Error("worker result unavailable");
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockRejectedValue(failure);
    const before = getCronJobsStoreRevision(storePath);
    await expect(loadCronJobsStoreWithConfigJobs(storePath)).rejects.toBe(failure);
    expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
  });

  it("preserves the coordinator cause used by Doctor diagnostics", () => {
    const native = Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" });
    const original = new SqliteCoordinatorError("repair completed but cleanup failed", native);
    const restored = restoreCronLoadError(serializeCronLoadError(original));
    expect(restored.name).toBe(original.name);
    expect(restored.cause).toMatchObject({ message: "database busy", code: "SQLITE_BUSY" });
    expect(formatErrorMessage(restored, { redact: (text) => text })).toBe(
      formatErrorMessage(original, { redact: (text) => text }),
    );
  });
});

it("persists full, changed, and runtime-only cron saves off the host through reopen", async () => {
  await withOpenClawTestState({ label: "cron-worker-save" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const otherPath = state.statePath("other", "jobs.json");
    const original = cronWorkerFixture();
    const sql = observeMainThreadSql();
    try {
      await saveCronJobsStore(storePath, original);
      await saveCronJobsStore(otherPath, original);
      const updated = structuredClone(original);
      updated.jobs[0]!.name = "changed configuration";
      updated.jobs[0]!.state.nextRunAtMs = 90_001;
      const committed = await saveCronJobsStoreChanges(storePath, original, updated);
      expect(committed.jobs[0]).toMatchObject({
        name: "changed configuration",
        state: { nextRunAtMs: 90_001 },
      });
      const runtime = structuredClone(committed);
      runtime.jobs[0]!.name = "runtime-only must not replace this name";
      runtime.jobs[0]!.state.nextRunAtMs = 120_001;
      await saveCronJobsStore(storePath, runtime, { stateOnly: true });
      const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(loaded.store.jobs[0]).toMatchObject({
        name: "changed configuration",
        state: { nextRunAtMs: 120_001 },
      });
      expect((await loadCronJobsStoreWithConfigJobs(otherPath)).store.jobs[0]?.name).toBe("first");
      sql.expectIdle();
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
      sql.clear();
      expect(await loadCronJobsStoreWithConfigJobs(storePath)).toEqual(loaded);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("preserves the cron conflict error class across an actual worker save", async () => {
  await withOpenClawTestState({ label: "cron-worker-save-conflict" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const previous = cronWorkerFixture();
    await saveCronJobsStore(storePath, previous);
    const authoritative = structuredClone(previous);
    authoritative.jobs[0]!.name = "current definition";
    await saveCronJobsStore(storePath, authoritative);
    const staleEdit = structuredClone(previous);
    staleEdit.jobs[0]!.name = "stale definition";
    await expect(saveCronJobsStoreChanges(storePath, previous, staleEdit)).rejects.toBeInstanceOf(
      CronJobsStoreChangedError,
    );
    expect((await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs[0]?.name).toBe(
      "current definition",
    );
  });
});

it("keeps native transaction hooks on the same connection and original job objects", async () => {
  await withOpenClawTestState({ label: "cron-native-save-hooks" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const store = cronWorkerFixture();
    const order: string[] = [];
    let beforeDatabase: DatabaseSync | undefined;
    let afterDatabase: DatabaseSync | undefined;
    await saveCronJobsStore(storePath, store, {
      transactionHooks: {
        beforeWrite: (db) => {
          beforeDatabase = db;
          store.jobs[0]!.name = "changed by native hook";
          order.push("before");
        },
        afterWrite: (db) => {
          afterDatabase = db;
          order.push("after");
        },
        afterCommit: () => {
          order.push("committed");
        },
      },
    });
    expect(beforeDatabase).toBeDefined();
    expect(afterDatabase).toBe(beforeDatabase);
    expect(order).toEqual(["before", "after", "committed"]);
    expect((await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs[0]?.name).toBe(
      "changed by native hook",
    );
  });
});

it("invalidates a committed native save before propagating a constructed post-commit error", async () => {
  await withOpenClawTestState({ label: "cron-native-save-publication" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const store = cronWorkerFixture();
    const before = getCronJobsStoreRevision(storePath);
    const failure = new Error("post-commit observer failed");
    await expect(
      saveCronJobsStore(storePath, store, {
        transactionHooks: {
          afterCommit: () => {
            throw failure;
          },
        },
      }),
    ).rejects.toBe(failure);
    expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
    expect(
      (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs.map((job) => job.id),
    ).toEqual(["first", "second"]);
  });
});

it.each([true, false])(
  "retains callback-bearing service commits on the host with scheduler enabled=%s",
  async (cronEnabled) => {
    await withOpenClawTestState({ label: "cron-callback-save" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      const store = cronWorkerFixture();
      for (const job of store.jobs) {
        job.enabled = false;
        job.state = {};
      }
      store.jobs[0]!.declarationKey = "agent:main:callback-save";
      await saveCronJobsStore(storePath, store);
      const service = new CronService({
        storePath,
        cronEnabled,
        defaultAgentId: "main",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: async () => ({ status: "skipped" }),
      });
      const input: CronJobCreate = {
        name: "callback save",
        enabled: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ordinary saved event" },
      };
      const steps: {
        name: string;
        invoke: (callback: () => undefined) => Promise<unknown>;
        precondition?: boolean;
      }[] = [
        {
          name: "guarded add",
          invoke: (callback) => service.add({ ...input, id: "guarded" }, { commitGuard: callback }),
        },
        {
          name: "captured add",
          invoke: (callback) =>
            service.add({ ...input, id: "captured" }, { captureRuntimeAuthority: callback }),
        },
        {
          name: "guarded convergence",
          invoke: (callback) =>
            service.add(
              { ...input, declarationKey: "agent:main:callback-save" },
              { commitGuard: callback },
            ),
        },
        {
          name: "guarded update",
          invoke: (callback) =>
            service.update("first", { name: "guarded update" }, { commitGuard: callback }),
        },
        {
          name: "captured update",
          invoke: (callback) =>
            service.update(
              "first",
              { name: "captured update" },
              { captureRuntimeAuthority: callback },
            ),
        },
        {
          name: "precondition update",
          precondition: true,
          invoke: (callback) =>
            service.updateWithPrecondition("first", { name: "precondition update" }, callback),
        },
        {
          name: "guarded remove",
          invoke: (callback) => service.remove("second", { commitGuard: callback }),
        },
      ];
      const order: string[] = [];
      const save = cronStore.saveCronJobsStoreWithRevisionNative;
      const saveChanges = cronStore.saveCronJobsStoreChangesWithRevisionNative;
      const fullCommit = vi
        .spyOn(cronStore, "saveCronJobsStoreWithRevisionNative")
        .mockImplementation((...args) => {
          const result = save(...args);
          order.push("commit");
          return result;
        });
      const changedCommit = vi
        .spyOn(cronStore, "saveCronJobsStoreChangesWithRevisionNative")
        .mockImplementation((...args) => {
          const result = saveChanges(...args);
          order.push("commit");
          return result;
        });
      try {
        await service.list({ includeDisabled: true });
        for (const step of steps) {
          order.length = 0;
          const callback = vi.fn(() => {
            if (step.name === "guarded remove") {
              expect(service.getJob("second")).toBeDefined();
            }
            order.push("callback");
            queueMicrotask(() => order.push("yield"));
            return undefined;
          });
          await step.invoke(callback);
          expect(callback, step.name).toHaveBeenCalledTimes(1);
          expect(order.filter((event) => event === "commit").length, step.name).toBeGreaterThan(0);
          expect(order[0], step.name).toBe("callback");
          if (!step.precondition) {
            // Preconditions already have an awaited contract; guards and captures do not.
            expect(order.lastIndexOf("commit"), step.name).toBeLessThan(order.indexOf("yield"));
          }
        }
        const persisted = (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs;
        expect(persisted.map((job) => job.id).toSorted()).toEqual(["captured", "first", "guarded"]);
        expect(persisted.find((job) => job.id === "first")?.name).toBe("precondition update");
        expect(persisted.every((job) => !job.enabled)).toBe(true);
      } finally {
        fullCommit.mockRestore();
        changedCommit.mockRestore();
        service.stop();
      }
    });
  },
);

describe("worker save result publication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { ok: true, committed: true },
    { ok: false, committed: true },
    { ok: false, committed: false },
  ])(
    "publishes committed or uncertain saves before success=$ok committed=$committed",
    async ({ ok, committed }) => {
      const storePath = `/synthetic/cron-save-${ok}-${committed}/jobs.json`;
      const failure = new Error("save settlement failed", {
        cause: Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" }),
      });
      const result: CronStoreSaveWorkerOperations["cron.save"]["output"] = ok
        ? { ok: true, committed, value: undefined }
        : { ok: false, committed, error: serializeCronSaveError(failure, storePath) };
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (_context, operation) => operation({ execute: vi.fn().mockResolvedValue(result) }),
      );
      const before = getCronJobsStoreRevision(storePath);
      if (ok) {
        await expect(
          saveCronJobsStore(storePath, { version: 1, jobs: [] }),
        ).resolves.toBeUndefined();
      } else {
        await expect(saveCronJobsStore(storePath, { version: 1, jobs: [] })).rejects.toMatchObject({
          message: "save settlement failed",
          cause: { message: "database busy", code: "SQLITE_BUSY" },
        });
      }
      expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
    },
  );

  it("invalidates before rejecting an unavailable write result", async () => {
    const storePath = "/synthetic/cron-save-unavailable/jobs.json";
    const failure = new Error("worker result unavailable");
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockRejectedValue(failure);
    const before = getCronJobsStoreRevision(storePath);
    await expect(saveCronJobsStore(storePath, { version: 1, jobs: [] })).rejects.toBe(failure);
    expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
  });

  it.each([false, true])(
    "keeps a stale save distinguishable after partition eviction before reply=%s",
    async (evictBeforeReply) => {
      const storePath = `/synthetic/cron-save-eviction-${evictBeforeReply}/jobs.json`;
      const pending = createDeferred<CronStoreSaveWorkerOperations["cron.save"]["output"]>();
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (_context, operation) =>
          operation({ execute: vi.fn().mockReturnValue(pending.promise) }),
      );
      const evictPartition = () => {
        for (let index = 0; index < 65; index += 1) {
          noteCronJobsStoreCommit(
            `/synthetic/cron-save-eviction-${evictBeforeReply}/peer-${index}`,
          );
        }
      };
      const save = saveCronJobsStoreWithRevision(storePath, { version: 1, jobs: [] });
      noteCronJobsStoreCommit(storePath);
      if (evictBeforeReply) {
        evictPartition();
      }
      pending.resolve({ ok: true, committed: true, value: undefined });
      const result = await save;
      expect(result.revision).not.toBe(getCronJobsStoreRevision(storePath));
      evictPartition();
      expect(result.revision).not.toBe(getCronJobsStoreRevision(storePath));
    },
  );

  it("does not reuse an untracked load revision after its committed partition is evicted", () => {
    const storePath = "/synthetic/cron-load-revision-eviction/jobs.json";
    const loadedRevision = getCronJobsStoreRevision(storePath);
    noteCronJobsStoreCommit(storePath);
    const trackedRevision = getCronJobsStoreRevision(storePath);
    noteCronJobsStoreCommit("/synthetic/cron-load-revision-eviction/peer-0");
    expect(getCronJobsStoreRevision(storePath)).toBe(trackedRevision);
    for (let index = 1; index < 65; index += 1) {
      noteCronJobsStoreCommit(`/synthetic/cron-load-revision-eviction/peer-${index}`);
    }
    expect(getCronJobsStoreRevision(storePath)).not.toBe(loadedRevision);
  });

  it.each([false, true])(
    "returns an operation-bound revision when an intervening commit exists=%s",
    async (intervening) => {
      const storePath = `/synthetic/cron-save-revision-${intervening}/jobs.json`;
      const pending = createDeferred<CronStoreSaveWorkerOperations["cron.save"]["output"]>();
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (_context, operation) =>
          operation({ execute: vi.fn().mockReturnValue(pending.promise) }),
      );
      const before = getCronJobsStoreRevision(storePath);
      const save = saveCronJobsStoreWithRevision(storePath, { version: 1, jobs: [] });
      if (intervening) {
        noteCronJobsStoreCommit(storePath);
      }
      pending.resolve({ ok: true, committed: true, value: undefined });
      const result = await save;
      const latest = getCronJobsStoreRevision(storePath);
      expect(latest).toBeGreaterThan(before);
      if (intervening) {
        expect(result.revision).toBeLessThan(0);
      } else {
        expect(result.revision).toBe(latest);
      }
    },
  );
});

import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteCoordinatorError } from "../infra/sqlite-lifecycle-errors.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { createCronMutationCompletion } from "./mutation-completion.js";
import { CronService } from "./service.js";
import { update as updateCronJob } from "./service/ops-mutations.js";
import * as runtimeMutation from "./service/runtime-mutation.js";
import { ensureLoaded, persist } from "./service/store.js";
import { stopTimer } from "./service/timer.js";
import * as sessionReaper from "./session-reaper.js";
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
  "commits guarded service mutations off the host with scheduler enabled=%s",
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
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
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
        singleUse?: boolean;
      }[] = [
        {
          name: "guarded add",
          invoke: (callback) => service.add({ ...input, id: "guarded" }, { commitGuard: callback }),
        },
        {
          name: "captured add",
          singleUse: true,
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
          singleUse: true,
          invoke: (callback) =>
            service.update(
              "first",
              { name: "captured update" },
              { captureRuntimeAuthority: callback },
            ),
        },
        {
          name: "guarded owner update",
          invoke: (callback) =>
            service.update(
              "first",
              {
                agentId: "other",
                sessionTarget: "isolated",
                payload: { kind: "agentTurn", message: "owner update" },
              },
              { commitGuard: callback },
            ),
        },
        {
          name: "captured owner update",
          singleUse: true,
          invoke: (callback) =>
            service.update("first", { agentId: "main" }, { captureRuntimeAuthority: callback }),
        },
        {
          name: "precondition update",
          singleUse: true,
          invoke: (callback) =>
            service.updateWithPrecondition("first", { name: "precondition update" }, callback),
        },
        {
          name: "guarded remove",
          invoke: (callback) => service.remove("second", { commitGuard: callback }),
        },
      ];
      const sql = observeMainThreadSql();
      try {
        await service.list({ includeDisabled: true });
        sql.calibrate();
        for (const step of steps) {
          sql.clear();
          const callback = vi.fn(() => {
            if (step.name === "guarded remove") {
              expect(service.getJob("second")).toBeDefined();
            }
            return undefined;
          });
          await step.invoke(callback);
          if (step.singleUse) {
            expect(callback, step.name).toHaveBeenCalledTimes(1);
          } else {
            expect(callback, step.name).toHaveBeenCalled();
          }
          expect.soft(sql.count(), step.name).toBe(0);
        }
        const persisted = (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs;
        expect(persisted.map((job) => job.id).toSorted()).toEqual(["captured", "first", "guarded"]);
        expect(persisted.find((job) => job.id === "first")?.name).toBe("precondition update");
        expect(persisted.every((job) => !job.enabled)).toBe(true);
      } finally {
        sql.restore();
        service.stop();
      }
    });
  },
);

it.each(["add", "update", "remove", "authority invalidation", "runtime update"] as const)(
  "preserves an unrelated peer %s while a guarded scheduler edit awaits admission",
  async (peerMutation) => {
    await withOpenClawTestState({ label: "cron-guarded-peer-write" }, async (fixture) => {
      const storePath = fixture.statePath("cron", "jobs.json");
      const original = cronWorkerFixture();
      for (const job of original.jobs) {
        job.enabled = false;
        job.state = {};
        job.agentId = job.id === "first" ? "alpha" : "beta";
      }
      if (peerMutation === "authority invalidation") {
        const job = expectDefined(original.jobs[1], "authority owner");
        job.sessionTarget = "isolated";
        job.payload = {
          kind: "agentTurn",
          message: "scheduled continuation",
          toolsAllow: ["read", "cron"],
          toolsAllowIsDefault: true,
        };
        job.toolsAllowProvenance = { version: 1, source: "final-executable-surface" };
        job.runtimeAuthority = {
          version: 1,
          runtimeId: "codex",
          namespace: "codex.apps",
          payload: { apps: [{ id: "calendar" }] },
        };
      }
      await saveCronJobsStore(storePath, original);
      const beforePeer = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(beforePeer.jobsFingerprint).toEqual(expect.any(String));
      if (peerMutation === "authority invalidation") {
        expect(beforePeer.store.jobs[1]?.runtimeAuthority).toEqual(
          original.jobs[1]?.runtimeAuthority,
        );
      }
      const state = createCronRegressionState({
        storePath,
        cronEnabled: true,
        runIsolatedAgentJob: async () => ({ status: "skipped" }),
      });
      const service = new CronService(state.deps);
      const entered = createDeferred();
      const release = createDeferred();
      const execute = runtimeMutation.runCronRuntimeMutation;
      const admission = vi
        .spyOn(runtimeMutation, "runCronRuntimeMutation")
        .mockImplementationOnce(async (params) => {
          entered.resolve();
          await release.promise;
          return execute(params);
        });
      const pending = service
        .update(
          "first",
          { name: "guarded edit" },
          { commitGuard: () => expect(service.getJob("first")?.name).toBe("first") },
        )
        .then(
          () => ({ committed: true as const }),
          (error: unknown) => ({ committed: false as const, error }),
        );
      try {
        await entered.promise;
        const peer = structuredClone(original);
        const second = expectDefined(peer.jobs[1], "peer job");
        if (peerMutation === "add") {
          peer.jobs.push({ ...structuredClone(second), id: "peer", name: "peer added" });
        } else if (peerMutation === "update") {
          second.name = "peer updated";
        } else if (peerMutation === "remove") {
          peer.jobs = peer.jobs.filter((job) => job.id !== second.id);
        } else if (peerMutation === "runtime update") {
          second.updatedAtMs = 10_000;
          second.state = {
            runningAtMs: 10_000,
            runningReceiptId: "peer-run-receipt",
            nextRunAtMs: 70_000,
          };
        } else {
          second.runtimeAuthorityRecoveryRequired = true;
          delete second.runtimeAuthority;
        }
        // This independent worker write commits while the service retains its older draft.
        if (peerMutation === "runtime update") {
          await saveCronJobsStore(storePath, peer, { stateOnly: true });
        } else {
          await saveCronJobsStoreChanges(storePath, original, peer);
        }
        const peerJobs = peer.jobs
          .filter((job) => job.id !== "first")
          .map(({ id, name, agentId, runtimeAuthorityRecoveryRequired, state: jobState }) => ({
            id,
            name,
            agentId,
            runtimeAuthorityRecoveryRequired,
            state: jobState,
          }));
        const readPeers = async () =>
          (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs
            .filter((job) => job.id !== "first")
            .map(({ id, name, agentId, runtimeAuthorityRecoveryRequired, state: jobState }) => ({
              id,
              name,
              agentId,
              runtimeAuthorityRecoveryRequired,
              state: jobState,
            }));
        expect(await readPeers()).toEqual(peerJobs);
        if (peerMutation === "authority invalidation" || peerMutation === "runtime update") {
          const invalidated = await loadCronJobsStoreWithConfigJobs(storePath);
          expect(invalidated.jobsFingerprint).toBe(beforePeer.jobsFingerprint);
          if (peerMutation === "authority invalidation") {
            expect(invalidated.store.jobs[1]?.runtimeAuthority).toBeUndefined();
          }
        }
        release.resolve();
        const result = await pending;
        if (!result.committed) {
          expect(result.error).toBeInstanceOf(CronJobsStoreChangedError);
        }
        expect(await readPeers()).toEqual(peerJobs);
        if (peerMutation === "authority invalidation") {
          expect(
            (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs[1]?.runtimeAuthority,
          ).toBeUndefined();
        }
        expect(
          (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs.find(
            (job) => job.id === "first",
          )?.name,
        ).toBe(result.committed ? "guarded edit" : "first");
      } finally {
        release.resolve();
        await pending;
        admission.mockRestore();
        service.stop();
      }
    });
  },
);

it("preserves a peer definition committed before a state-only save and later guarded edit", async () => {
  await withOpenClawTestState({ label: "cron-state-only-peer-write" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const original = cronWorkerFixture();
    for (const job of original.jobs) {
      job.enabled = false;
      job.state = {};
      job.agentId = "alpha";
    }
    await saveCronJobsStore(storePath, original);
    const state = createCronRegressionState({
      storePath,
      cronEnabled: true,
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
    });
    try {
      await ensureLoaded(state);
      const peer = structuredClone(original);
      peer.jobs.push({
        ...structuredClone(expectDefined(peer.jobs[1], "peer template")),
        id: "peer",
        name: "peer added",
        agentId: "beta",
      });
      await saveCronJobsStoreChanges(storePath, original, peer);
      expect(await persist(state, { stateOnly: true })).toBe(true);
      const beforeEdit = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(beforeEdit.store.jobs.find((job) => job.id === "peer")).toMatchObject({
        name: "peer added",
        agentId: "beta",
      });
      const result = await updateCronJob(
        state,
        "first",
        { name: "guarded edit" },
        {
          commitGuard: () =>
            expect(state.store?.jobs.find((job) => job.id === "first")?.name).toBe("first"),
        },
      ).then(
        () => ({ committed: true as const }),
        (error: unknown) => ({ committed: false as const, error }),
      );
      if (!result.committed) {
        expect(result.error).toBeInstanceOf(CronJobsStoreChangedError);
      }
      const persisted = (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs;
      expect(persisted.find((job) => job.id === "peer")).toMatchObject({
        name: "peer added",
        agentId: "beta",
      });
      expect(persisted.find((job) => job.id === "first")?.name).toBe(
        result.committed ? "guarded edit" : "first",
      );
    } finally {
      stopTimer(state);
    }
  });
});

it.each(["rename", "disable", "remove", "add"] as const)(
  "reconciles a committed %s when its worker reply is lost without replay",
  async (mutation) => {
    await withOpenClawTestState({ label: "cron-guarded-lost-reply" }, async (fixture) => {
      const storePath = fixture.statePath("cron", "jobs.json");
      const store = cronWorkerFixture();
      for (const job of store.jobs) {
        job.state.nextRunAtMs = Date.now() + 60_000;
      }
      await saveCronJobsStore(storePath, store);
      const onEvent = vi.fn();
      const state = createCronRegressionState({
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        nowMs: () => Date.now(),
        onEvent,
        runIsolatedAgentJob: async () => ({ status: "skipped" }),
      });
      const service = new CronService(state.deps);
      const marker = expectDefined(markCronJobActive("first"), "active run");
      const method =
        mutation === "remove" ? "cron.remove" : mutation === "add" ? "cron.add" : "cron.update";
      const completion = expectDefined(createCronMutationCompletion(method), "mutation receipt");
      const dropped = loseFirstCronMutationReply("cron.mutateJobs");
      const commitGuard = () => {
        expect(service.getJob("first")?.name).toBe("first");
      };
      try {
        const result = await completion
          .run(async () => {
            if (mutation === "remove") {
              return await service.remove("first", { commitGuard });
            }
            if (mutation === "add") {
              return await service.add(
                {
                  id: "added",
                  name: "accepted add",
                  enabled: true,
                  schedule: { kind: "every", everyMs: 60_000 },
                  sessionTarget: "main",
                  wakeMode: "next-heartbeat",
                  payload: { kind: "systemEvent", text: "synthetic event" },
                },
                { commitGuard },
              );
            }
            return await service.update(
              "first",
              {
                name: "accepted edit",
                ...(mutation === "disable" ? { enabled: false } : {}),
              },
              { commitGuard },
            );
          })
          .then(
            () => "reported",
            () => "reply-lost",
          );
        expect(result).toBe("reply-lost");
        expect(dropped.wasDropped()).toBe(true);
        expect(dropped.attempts).toEqual(["cron.mutateJobs"]);
        expect(completion.isCommitted()).toBe(true);
        if (mutation === "remove") {
          expect.soft(service.getJob("first")).toBeUndefined();
          expect.soft(marker.jobRemoved).toBe(true);
        } else {
          expect
            .soft(service.getJob(mutation === "add" ? "added" : "first")?.name)
            .toBe(mutation === "add" ? "accepted add" : "accepted edit");
        }
        if (mutation === "remove" || mutation === "disable") {
          expect.soft(marker.cancellation?.kind).toBe("requested");
        }
        expect.soft(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: mutation === "add" ? "added" : "first",
            action: mutation === "remove" ? "removed" : mutation === "add" ? "added" : "updated",
          }),
        );
        await dropped.waitForExit();
        const persisted = (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs;
        if (mutation === "remove") {
          expect(persisted.some((job) => job.id === "first")).toBe(false);
        } else {
          expect(
            persisted.find((job) => job.id === (mutation === "add" ? "added" : "first"))?.name,
          ).toBe(mutation === "add" ? "accepted add" : "accepted edit");
        }
      } finally {
        await dropped.close();
        clearCronJobActive("first", marker);
        service.stop();
      }
    });
  },
);

it.each([false, true])(
  "retains base-session cleanup after a committed removal loses its reply (active=%s)",
  async (active) => {
    await withOpenClawTestState({ label: "cron-removed-reply-cleanup" }, async (fixture) => {
      const storePath = fixture.statePath("cron", "jobs.json");
      const sessionStorePath = fixture.statePath("agents", "main", "sessions", "sessions.json");
      const store = cronWorkerFixture();
      const job = expectDefined(store.jobs[0], "removed job");
      job.sessionTarget = "isolated";
      job.payload = { kind: "agentTurn", message: "synthetic work" };
      await saveCronJobsStore(storePath, store);
      const state = createCronRegressionState({
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        nowMs: () => Date.now(),
        runIsolatedAgentJob: async () => ({ status: "skipped" }),
      });
      const service = new CronService({ ...state.deps, sessionStorePath });
      const cleanupCalled = createDeferred();
      const cleanup = vi
        .spyOn(sessionReaper, "removeCronJobBaseSession")
        .mockImplementation(async () => {
          cleanupCalled.resolve();
          return true;
        });
      const marker = active ? markCronJobActive(job.id) : undefined;
      if (marker) {
        marker.cancellation = {
          kind: "bound",
          cancel() {
            throw new Error("cancellation listener failed");
          },
        };
      }
      const dropped = loseFirstCronMutationReply("cron.mutateJobs");
      try {
        await expect(service.remove(job.id)).rejects.toThrow();
        expect(dropped.wasDropped()).toBe(true);
        expect(service.getJob(job.id)).toBeUndefined();
        if (marker) {
          expect(marker.jobRemoved).toBe(true);
          expect(cleanup).not.toHaveBeenCalled();
          clearCronJobActive(job.id, marker);
        }
        await cleanupCalled.promise;
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledWith({ agentId: "main", jobId: job.id, sessionStorePath });
      } finally {
        await dropped.close();
        clearCronJobActive(job.id, marker);
        service.stop();
        cleanup.mockRestore();
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
        ? {
            ok: true,
            committed,
            value: undefined,
            jobsFingerprint: "synthetic-fingerprint",
            runtimeFingerprint: "synthetic-runtime-fingerprint",
          }
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
      pending.resolve({
        ok: true,
        committed: true,
        value: undefined,
        jobsFingerprint: "synthetic-fingerprint",
        runtimeFingerprint: "synthetic-runtime-fingerprint",
      });
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
      pending.resolve({
        ok: true,
        committed: true,
        value: undefined,
        jobsFingerprint: "synthetic-fingerprint",
        runtimeFingerprint: "synthetic-runtime-fingerprint",
      });
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

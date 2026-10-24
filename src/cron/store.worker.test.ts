import { expectDefined } from "@openclaw/normalization-core";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { SqliteCoordinatorError } from "../infra/sqlite-lifecycle-errors.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { createCronMutationCompletion } from "./mutation-completion.js";
import { CronService } from "./service.js";
import * as runtimeMutation from "./service/runtime-mutation.js";
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
import { expectPathMissing } from "./store.test-support.js";
import { withCronStore } from "./store.worker.test-support.js";
import { prepareCronJobNameResolver } from "./store/job-name.js";
import { serializeCronLoadError } from "./store/load-error.js";
import type { CronStoreWorkerOperations } from "./store/load-worker.types.js";
import { serializeCronSaveError } from "./store/save-error.js";
import type { CronStoreSaveWorkerOperations } from "./store/save-worker.types.js";
import type { CronJobCreate, CronStoreFile } from "./types.js";

function jobInput(name: string, text: string, enabled = true) {
  return {
    name,
    enabled,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text },
  } satisfies CronJobCreate;
}

function cronWorkerFixture(): CronStoreFile {
  return {
    version: 1,
    jobs: ["first", "second"].map((id) =>
      Object.assign(jobInput(id, "scheduled café 🦞"), {
        id,
        createdAtMs: 1,
        updatedAtMs: 2,
        state: { nextRunAtMs: 60_001 },
      }),
    ),
  };
}

function createService(
  storePath: string,
  options: Partial<Parameters<typeof createCronRegressionState>[0]> = {},
) {
  return new CronService(
    createCronRegressionState({
      storePath,
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
      ...options,
    }).deps,
  );
}

function peerJobs(jobs: CronStoreFile["jobs"]) {
  return jobs
    .filter((job) => job.id !== "first")
    .map(({ id, name, agentId, runtimeAuthorityRecoveryRequired, state }) => ({
      id,
      name,
      agentId,
      runtimeAuthorityRecoveryRequired,
      state,
    }));
}

function successfulSave() {
  return {
    ok: true as const,
    value: undefined,
    names: new Map<string, string | undefined>(),
    jobsFingerprint: "synthetic-fingerprint",
    runtimeFingerprint: "synthetic-runtime-fingerprint",
  };
}

afterEach(() => vi.restoreAllMocks());

it.each([
  ["load", true, 2],
  ["load", false, 2],
  ["load", false, 0],
  ["save", true, 1],
  ["save", false, 1],
  ["save", false, 0],
] as const)(
  "publishes %s results before settling success=%s commits=%s",
  async (operation, ok, commits) => {
    const storePath = `/synthetic/cron-${operation}-${ok}-${commits}/jobs.json`;
    const loading = operation === "load";
    const cause = Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" });
    const message = loading ? "later load stage failed" : "save settlement failed";
    const failure = loading
      ? Object.assign(new SqliteCoordinatorError(message, cause), { code: "SQLITE_ERROR" })
      : new Error(message, { cause });
    const result:
      | CronStoreWorkerOperations["cron.loadMutable"]["output"]
      | CronStoreSaveWorkerOperations["cron.save"]["output"] = loading
      ? {
          storeKey: storePath,
          repairCommits: commits,
          ...(ok
            ? {
                ok: true as const,
                loaded: {
                  store: { version: 1 as const, jobs: [] },
                  configJobs: [],
                  configJobIndexes: [],
                  configJobRuntimeEntries: [],
                  invalidConfigRows: [],
                },
              }
            : { ok: false as const, error: serializeCronLoadError(failure) }),
        }
      : {
          committed: Boolean(commits),
          ...(ok
            ? successfulSave()
            : { ok: false as const, error: serializeCronSaveError(failure, storePath) }),
        };
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      async (_context, execute) => execute({ execute: vi.fn().mockResolvedValue(result) }),
    );
    if (loading) {
      noteCronJobsStoreCommit(storePath);
    }
    const before = getCronJobsStoreRevision(storePath);
    const pending = loading
      ? loadCronJobsStoreWithConfigJobs(storePath)
      : saveCronJobsStore(storePath, { version: 1, jobs: [] });
    if (ok) {
      if (loading) {
        await expect(pending).resolves.toHaveProperty("store.jobs", []);
      } else {
        await expect(pending).resolves.toBeUndefined();
      }
    } else {
      await expect(pending).rejects.toMatchObject({
        message,
        cause: { message: "database busy", code: "SQLITE_BUSY" },
        ...(loading ? { name: failure.name, code: "SQLITE_ERROR" } : {}),
      });
      if (loading) {
        await pending.catch((error: unknown) => {
          expect(formatErrorMessage(error, { redact: (text) => text })).toBe(
            formatErrorMessage(failure, { redact: (text) => text }),
          );
        });
      }
    }
    if (loading) {
      expect(getCronJobsStoreRevision(storePath)).toBe(before + Math.max(1, commits));
    } else {
      expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
    }
  },
);

it.each(["load", "save", "default"])(
  "invalidates when transport cannot provide a %s result",
  async (operation) => {
    const storePath = `/synthetic/cron-unavailable-${operation}/jobs.json`;
    const failure = new Error("worker result unavailable");
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockRejectedValue(failure);
    if (operation === "default") {
      noteCronJobsStoreCommit(storePath);
    }
    const before = getCronJobsStoreRevision(storePath);
    const result =
      operation === "save"
        ? saveCronJobsStore(storePath, { version: 1, jobs: [] })
        : loadCronJobsStoreWithConfigJobs(operation === "default" ? undefined : storePath);
    await expect(result).rejects.toBe(failure);
    expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
  },
);

it("loads the current default cron partition after in-process writes without host SQL", async () => {
  await withCronStore("cron-worker-default", async (state) => {
    const firstPath = state.statePath("first", "jobs.json");
    const secondPath = state.statePath("second", "jobs.json");
    const first = cronWorkerFixture();
    const second = { ...first, jobs: first.jobs.slice(1) };
    await saveCronJobsStore(firstPath, first);
    await saveCronJobsStore(secondPath, second);
    const sql = observeMainThreadSql();
    try {
      for (const [storePath, expected] of [
        [firstPath, ["first", "second"]],
        [secondPath, ["second"]],
      ] as const) {
        writeConfigMachineState("cron.store", storePath);
        sql.clear();

        const loaded = await loadCronJobsStoreWithConfigJobs();

        expect(loaded.store.jobs.map((job) => job.id)).toEqual(expected);
        sql.expectIdle();
      }
    } finally {
      sql.restore();
    }
  });
});

it("persists full, changed, and runtime-only cron saves off the host through reopen", async () => {
  await withCronStore("cron-worker-save", async (state) => {
    const { storePath } = state;
    const otherPath = state.statePath("other", "jobs");
    const original = cronWorkerFixture();
    original.jobs[0]!.state = {
      nextRunAtMs: 60_001,
      startupCatchupAtMs: 60_001,
      pacedNextRunAtMs: 60_001,
      queuedAtMs: 60_002,
      lastStatus: "ok",
    };
    const sql = observeMainThreadSql();
    try {
      await saveCronJobsStore(storePath, original);
      await saveCronJobsStore(storePath, original);
      const queued = (await state.load()).store.jobs[0]!.state;
      expect(queued).toEqual({ ...original.jobs[0]!.state, lastRunStatus: "ok" });
      expect(queued.runningAtMs).toBeUndefined();
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
      runtime.jobs = runtime.jobs.slice(0, 1);
      runtime.jobs[0]!.name = "runtime-only must not replace this name";
      runtime.jobs[0]!.updatedAtMs += 60_000;
      runtime.jobs[0]!.state = {
        nextRunAtMs: 120_001,
        lastRunAtMs: 90_001,
        runningAtMs: 90_002,
        lastStatus: "error",
        consecutiveErrors: 10,
        autoDisabled: { reason: "consecutive-failures", atMs: 90_001, consecutiveErrors: 10 },
      };
      await saveCronJobsStore(storePath, runtime, { stateOnly: true });
      await saveCronJobsStore(storePath, runtime, { stateOnly: true });
      const loaded = await state.load();
      expect(loaded.store.jobs.map(({ id }) => id)).toEqual(["first", "second"]);
      expect(loaded.store.jobs[0]?.name).toBe("changed configuration");
      expect(loaded.store.jobs[0]?.state).toEqual({
        ...runtime.jobs[0]!.state,
        nextRunAtMs: 120_001,
        lastRunStatus: "error",
      });
      expect(loaded.store.jobs[0]?.state.queuedAtMs).toBeUndefined();
      expect((await loadCronJobsStoreWithConfigJobs(otherPath)).store.jobs[0]?.name).toBe("first");
      sql.expectIdle();
      await state.close();
      sql.clear();
      expect(await state.load()).toEqual(loaded);
      sql.expectIdle();
      for (const path of [
        storePath,
        storePath.replace(/\.json$/, "-state.json"),
        `${storePath}.bak`,
        otherPath,
        `${otherPath}-state.json`,
      ]) {
        await expectPathMissing(path);
      }
    } finally {
      sql.restore();
    }
  });
});

it("preserves the cron conflict error class across an actual worker save", async () => {
  await withCronStore("cron-worker-save-conflict", async (state) => {
    const { storePath } = state;
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
    expect((await state.load()).store.jobs[0]?.name).toBe("current definition");
  });
});

it.each([false, true])(
  "publishes native saves with ordered hooks before observer failure=%s",
  async (fail) => {
    await withCronStore("cron-native-save-hooks", async (state) => {
      const { storePath } = state;
      const store = cronWorkerFixture();
      const order: string[] = [];
      let beforeDatabase: EngineConnection | undefined;
      let afterDatabase: EngineConnection | undefined;
      const before = getCronJobsStoreRevision(storePath);
      const failure = new Error("post-commit observer failed");
      const save = saveCronJobsStore(storePath, store, {
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
            if (fail) {
              throw failure;
            }
          },
        },
      });
      if (fail) {
        await expect(save).rejects.toBe(failure);
      } else {
        await save;
      }
      expect(beforeDatabase).toBeDefined();
      expect(afterDatabase).toBe(beforeDatabase);
      expect(order).toEqual(["before", "after", "committed"]);
      expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
      const loaded = (await state.load()).store.jobs;
      expect(loaded[0]?.name).toBe("changed by native hook");
      expect(loaded.map((job) => job.id)).toEqual(["first", "second"]);
    });
  },
);

it.each([true, false])(
  "commits guarded service mutations off the host with scheduler enabled=%s",
  async (cronEnabled) => {
    await withCronStore("cron-callback-save", async (state) => {
      const { storePath } = state;
      const store = cronWorkerFixture();
      for (const job of store.jobs) {
        job.enabled = false;
        job.state = {};
      }
      store.jobs[0]!.declarationKey = "agent:main:callback-save";
      store.jobs.push({ ...store.jobs[0]!, id: "broken", name: "Broken metadata" });
      store.jobs.push({ ...store.jobs[1]!, id: "legacy", name: "Legacy JSON name" });
      await saveCronJobsStore(storePath, store);
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?").run(
          "{",
          storePath,
          "broken",
        );
        db.prepare(
          "UPDATE cron_jobs SET name = ?, job_json = json_set(job_json, '$.delivery', json(?)) WHERE store_key = ? AND job_id = ?",
        ).run("  Legacy metadata  ", JSON.stringify({ mode: "unsupported" }), storePath, "legacy");
      });
      const resolveName = await prepareCronJobNameResolver(
        ["first", "second", "guarded", "captured-\ud800", "broken", "legacy"],
        storePath,
      );
      const service = createService(storePath, {
        cronEnabled,
        defaultAgentId: "main",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const input = jobInput("callback save", "ordinary saved event", false);
      const options = (callback: () => undefined, captured: boolean) =>
        captured ? { captureRuntimeAuthority: callback } : { commitGuard: callback };
      const add =
        (job: CronJobCreate, captured = false) =>
        (callback: () => undefined) =>
          service.add(job, options(callback, captured));
      const update =
        (patch: Parameters<CronService["update"]>[1], captured = false) =>
        (callback: () => undefined) =>
          service.update("first", patch, options(callback, captured));
      const steps: [
        string,
        (callback: () => undefined) => Promise<unknown>,
        Record<string, string | undefined>,
        boolean?,
      ][] = [
        [
          "guarded add",
          add({ ...input, id: " guarded " }),
          { guarded: "callback save", first: "first", second: "second" },
        ],
        [
          "captured add",
          add({ ...input, id: "captured-\ud800", name: "callback \ud800" }, true),
          { "captured-\ud800": "callback \ufffd" },
          true,
        ],
        [
          "guarded convergence",
          add({ ...input, declarationKey: "agent:main:callback-save" }),
          { first: "first" },
        ],
        ["guarded update", update({ name: "guarded update" }), { first: "guarded update" }],
        [
          "captured update",
          update({ name: "captured update" }, true),
          { first: "captured update" },
          true,
        ],
        [
          "guarded owner update",
          update({
            agentId: "other",
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "owner update" },
          }),
          { first: "captured update" },
        ],
        [
          "captured owner update",
          update({ agentId: "main" }, true),
          { first: "captured update" },
          true,
        ],
        [
          "precondition update",
          (callback) =>
            service.updateWithPrecondition("first", { name: "precondition update" }, callback),
          { first: "precondition update" },
          true,
        ],
        [
          "guarded remove",
          (callback) => service.remove("second", { commitGuard: callback }),
          { second: undefined },
        ],
      ];
      const sql = observeMainThreadSql();
      try {
        await service.list({ includeDisabled: true });
        sql.calibrate();
        for (const [name, invoke, names, singleUse] of steps) {
          sql.clear();
          const callback = vi.fn(() => {
            if (name === "guarded remove") {
              expect(service.getJob("second")).toBeDefined();
            }
            return undefined;
          });
          await invoke(callback);
          expect(resolveName("broken")).toBe(cronEnabled ? undefined : "Broken metadata");
          expect(resolveName("legacy")).toBe("Legacy metadata");
          for (const [jobId, expectedName] of Object.entries(names)) {
            expect(resolveName(jobId), `${name}: ${jobId}`).toBe(expectedName);
          }
          if (singleUse) {
            expect(callback, name).toHaveBeenCalledTimes(1);
          } else {
            expect(callback, name).toHaveBeenCalled();
          }
          expect.soft(sql.count(), name).toBe(0);
        }
        const persisted = (await state.load()).store.jobs;
        expect(persisted.map((job) => job.id).toSorted()).toEqual([
          "captured-\ufffd",
          "first",
          "guarded",
          "legacy",
        ]);
        expect(persisted.find((job) => job.id === "first")?.name).toBe("precondition update");
        expect(persisted.every((job) => !job.enabled)).toBe(true);
      } finally {
        sql.restore();
        service.stop();
      }
    });
  },
);

it.each([
  "add",
  "update",
  "remove",
  "authority invalidation",
  "runtime update",
  "target runtime update",
] as const)(
  "preserves a committed %s while a guarded scheduler edit awaits admission",
  async (peerMutation) => {
    await withCronStore("cron-guarded-peer-write", async (fixture) => {
      const { storePath } = fixture;
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
      const beforePeer = await fixture.load();
      expect(beforePeer.jobsFingerprint).toEqual(expect.any(String));
      if (peerMutation === "authority invalidation") {
        expect(beforePeer.store.jobs[1]?.runtimeAuthority).toEqual(
          original.jobs[1]?.runtimeAuthority,
        );
      }
      const service = createService(storePath);
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
        } else if (peerMutation === "runtime update" || peerMutation === "target runtime update") {
          const target = peerMutation === "target runtime update" ? peer.jobs[0]! : second;
          target.updatedAtMs = 10_000;
          target.state = {
            runningAtMs: 10_000,
            runningReceiptId: "peer-run-receipt",
            nextRunAtMs: 70_000,
          };
        } else {
          second.runtimeAuthorityRecoveryRequired = true;
          delete second.runtimeAuthority;
        }
        // This independent worker write commits while the service retains its older draft.
        if (peerMutation === "runtime update" || peerMutation === "target runtime update") {
          await saveCronJobsStore(storePath, peer, { stateOnly: true });
        } else {
          await saveCronJobsStoreChanges(storePath, original, peer);
        }
        const readPeers = async () => peerJobs((await fixture.load()).store.jobs);
        const expectedPeers = peerJobs(peer.jobs);
        expect(await readPeers()).toEqual(expectedPeers);
        if (peerMutation === "authority invalidation" || peerMutation === "runtime update") {
          const invalidated = await fixture.load();
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
        const settledJobs = (await fixture.load()).store.jobs;
        expect(peerJobs(settledJobs)).toEqual(expectedPeers);
        if (peerMutation === "target runtime update") {
          expect(settledJobs[0]?.state).toEqual(peer.jobs[0]?.state);
        }
        if (peerMutation === "authority invalidation") {
          expect(settledJobs[1]?.runtimeAuthority).toBeUndefined();
        }
        expect(settledJobs.find((job) => job.id === "first")?.name).toBe(
          result.committed ? "guarded edit" : "first",
        );
      } finally {
        release.resolve();
        await pending;
        admission.mockRestore();
        service.stop();
      }
    });
  },
);

it.each([
  ["rename", true, true],
  ["disable", true, true],
  ["remove", true, true],
  ["add", true, true],
  ["remove", true, false],
  ["remove", false, false],
] as const)(
  "reloads durable %s after reply loss (active=%s guarded=%s)",
  async (mutation, active, guarded) => {
    await withCronStore("cron-guarded-lost-reply", async (fixture) => {
      const { storePath } = fixture;
      const store = cronWorkerFixture();
      for (const job of store.jobs) {
        job.state.nextRunAtMs = Date.now() + 60_000;
      }
      if (!guarded) {
        Object.assign(store.jobs[0]!, {
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "synthetic work" },
        });
      }
      await saveCronJobsStore(storePath, store);
      const resolveName = await prepareCronJobNameResolver(["first", "added"], storePath);
      const onEvent = vi.fn();
      const service = createService(storePath, {
        onEvent,
        defaultAgentId: "main",
        cronEnabled: guarded,
        ...(!guarded
          ? { sessionStorePath: fixture.statePath("agents", "main", "sessions", "sessions.json") }
          : {}),
      });
      const marker = active ? expectDefined(markCronJobActive("first"), "active run") : undefined;
      const cleanup = !guarded
        ? vi.spyOn(sessionReaper, "removeCronJobBaseSession").mockResolvedValue(true)
        : undefined;
      const method =
        mutation === "remove" ? "cron.remove" : mutation === "add" ? "cron.add" : "cron.update";
      const completion = expectDefined(createCronMutationCompletion(method), "mutation receipt");
      const dropped = loseFirstCronMutationReply("cron.mutateJobs");
      const commitGuard = () => {
        expect(service.getJob("first")?.name).toBe("first");
      };
      try {
        const operation = async () => {
          if (mutation === "remove") {
            return await service.remove("first", guarded ? { commitGuard } : undefined);
          }
          if (mutation === "add") {
            return await service.add(
              { ...jobInput("accepted add", "synthetic event"), id: "added" },
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
        };
        const pending = guarded ? completion.run(operation) : operation();
        if (!guarded) {
          await expect(pending).rejects.toThrow();
        }
        const result = await pending.then(
          () => "reported",
          () => "reply-lost",
        );
        expect(result).toBe("reply-lost");
        expect(dropped.wasDropped()).toBe(true);
        expect(dropped.attempts).toEqual(["cron.mutateJobs"]);
        expect(completion.isCommitted()).toBe(false);
        expect(() => resolveName(mutation === "add" ? "added" : "first")).toThrow("need refresh");
        expect(marker?.jobRemoved).not.toBe(true);
        expect(marker?.cancellation?.kind).not.toBe("requested");
        expect(onEvent).not.toHaveBeenCalled();
        await dropped.waitForExit();
        const persisted = (await fixture.load()).store.jobs;
        const refreshed = await service.list({ includeDisabled: true });
        const byId = (left: { id: string }, right: { id: string }) =>
          left.id.localeCompare(right.id);
        expect(refreshed.toSorted(byId)).toEqual(persisted.toSorted(byId));
        const refreshedName = await prepareCronJobNameResolver(["first", "added"], storePath);
        expect(refreshedName(mutation === "add" ? "added" : "first")).toBe(
          mutation === "remove" ? undefined : mutation === "add" ? "accepted add" : "accepted edit",
        );
        if (mutation === "remove") {
          expect(persisted.some((job) => job.id === "first")).toBe(false);
          expect(service.getJob("first")).toBeUndefined();
          if (marker) {
            expect(marker.jobRemoved).not.toBe(true);
          }
          if (cleanup) {
            if (marker) {
              clearCronJobActive("first", marker);
            }
            expect(cleanup).not.toHaveBeenCalled();
          }
        } else {
          const current = persisted.find(
            (job) => job.id === (mutation === "add" ? "added" : "first"),
          );
          expect(current?.name).toBe(mutation === "add" ? "accepted add" : "accepted edit");
          if (mutation === "disable") {
            expect(current?.enabled).toBe(false);
          }
          expect(service.getJob(current!.id)).toEqual(current);
        }
      } finally {
        await dropped.close();
        clearCronJobActive("first", marker);
        service.stop();
        cleanup?.mockRestore();
      }
    });
  },
);

it.each(["unchanged", "intervening", "evicted before reply", "evicted after reply"] as const)(
  "returns an operation-bound save revision (%s)",
  async (change) => {
    const storePath = `/synthetic/cron-save-revision-${change}/jobs.json`;
    const pending = createDeferred<CronStoreSaveWorkerOperations["cron.save"]["output"]>();
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      async (_context, operation) =>
        operation({ execute: vi.fn().mockReturnValue(pending.promise) }),
    );
    const evictPartition = () => {
      for (let index = 0; index < 65; index += 1) {
        noteCronJobsStoreCommit(`${storePath}/peer-${index}`);
      }
    };
    const before = getCronJobsStoreRevision(storePath);
    const save = saveCronJobsStoreWithRevision(storePath, { version: 1, jobs: [] });
    if (change !== "unchanged") {
      noteCronJobsStoreCommit(storePath);
    }
    if (change === "evicted before reply") {
      evictPartition();
    }
    pending.resolve({ ...successfulSave(), committed: true });
    const result = await save;
    const latest = getCronJobsStoreRevision(storePath);
    expect(latest).toBeGreaterThan(before);
    if (change === "unchanged") {
      expect(result.revision).toBe(latest);
    } else {
      expect(result.revision).toBeLessThan(0);
      expect(result.revision).not.toBe(latest);
    }
    if (change.startsWith("evicted")) {
      evictPartition();
      expect(result.revision).not.toBe(getCronJobsStoreRevision(storePath));
    }
  },
);

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withTimeout } from "../utils/with-timeout.js";
import { CronService } from "./service.js";
import { createCronStoreHarness, writeCronStoreSnapshot } from "./service.test-harness.js";
import { getSuspensionVisibleCronTaskRunCount } from "./service/active-run-cancellation.js";
import { stop } from "./service/ops-lifecycle.js";
import { add, remove } from "./service/ops-mutations.js";
import { status as readStatus } from "./service/ops-read.js";
import * as scheduleMaintenance from "./service/schedule-maintenance.js";
import type { CronServiceDeps } from "./service/state.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import * as cronStoreModule from "./store.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const sqliteTransactionLabels = vi.hoisted(() => [] as string[]);

vi.mock("../state/openclaw-state-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-db.js")>();
  const runOpenClawStateWriteTransaction: typeof actual.runOpenClawStateWriteTransaction = (
    operation,
    options,
    transactionOptions,
  ) => {
    sqliteTransactionLabels.push(transactionOptions?.operationLabel ?? "state.write");
    return actual.runOpenClawStateWriteTransaction(operation, options, transactionOptions);
  };
  return { ...actual, runOpenClawStateWriteTransaction };
});

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

type IsolatedRunResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
};

const { makeStorePath } = createCronStoreHarness();

function createDeferredIsolatedRun() {
  const result = createDeferred<IsolatedRunResult>();
  const started = createDeferred();
  const runIsolatedAgentJob = vi.fn(async () => {
    started.resolve();
    return await result.promise;
  });
  return {
    runIsolatedAgentJob,
    runStarted: started.promise,
    completeRun: result.resolve,
    settle: async (run?: Promise<unknown>) => {
      // The caller stops scheduling first; storage must outlive the admitted core and tick.
      result.resolve({ status: "ok", summary: "done" });
      try {
        await run;
      } finally {
        expect(getSuspensionVisibleCronTaskRunCount()).toBe(0);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      }
    },
  };
}

function createService(storePath: string, deps: Partial<CronServiceDeps> = {}) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent: vi.fn(),
    runSessionEvent: vi.fn(async () => ({ status: "ok" as const })),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
  });
}

async function readResponsiveCronSnapshot(cron: CronService) {
  const jobs = await withTimeout(cron.list({ includeDisabled: true }), 300, {
    message: "cron.list during service work timed out",
  });
  expect(jobs).toHaveLength(1);
  const status = await withTimeout(cron.status(), 300, {
    message: "cron.status during service work timed out",
  });
  expect(status).toMatchObject({ enabled: true, storage: "sqlite", jobs: 1 });
  expect(status.sqlitePath).toContain("openclaw.sqlite");
  expect(status.storePath).toBe(status.sqlitePath);
  if (status.nextWakeAtMs !== null) {
    expect(status.nextWakeAtMs).toBeTypeOf("number");
  }
  return jobs;
}

function futureJob(id: string, nowMs: number, withNextRun = true): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: nowMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: withNextRun ? { nextRunAtMs: nowMs + 60_000 } : {},
  };
}

describe("CronService read ops while job is running", () => {
  it("publishes the scheduler's next run after a cached list and status read", async () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const store = await makeStorePath();
    const cron = createService(store.storePath, { scheduler });
    try {
      await cron.start();
      const job = await cron.add({
        name: "snapshot tick",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "snapshot tick" },
      });
      const before = await cron.listPage();
      const beforeStatus = await cron.status();
      expect(before.jobs[0]?.state.nextRunAtMs).toBe(now + 60_000);
      expect(await cron.status()).toBe(beforeStatus);
      await cron.update(job.id, { name: "updated snapshot tick" });
      const updatedStatus = await cron.status();
      expect(updatedStatus).not.toBe(beforeStatus);
      expect(await cron.status()).toBe(updatedStatus);
      expect((await cron.listPage()).jobs[0]?.name).toBe("updated snapshot tick");

      await clock.advanceTo(now + 60_000);

      const after = await cron.listPage();
      const afterStatus = await cron.status();
      expect(after.jobs[0]).toMatchObject({
        id: job.id,
        state: { lastRunAtMs: now + 60_000, nextRunAtMs: now + 120_000 },
      });
      expect(afterStatus.nextWakeAtMs).toBe(now + 120_000);
      expect(afterStatus).not.toBe(updatedStatus);
      expect(await cron.status()).toBe(afterStatus);
      expect(after.snapshotRevision).not.toBe(before.snapshotRevision);
      expect(before.jobs[0]?.state.nextRunAtMs).toBe(now + 60_000);
    } finally {
      cron.stop();
      await scheduler.stop();
      await store.cleanup();
    }
  });

  it("keeps started read operations observational across a large stable store", async () => {
    const nowMs = Date.parse("2026-08-30T12:00:00.000Z");
    const store = await makeStorePath();
    const jobs = Array.from({ length: 100 }, (_, index) => futureJob(`stable-${index}`, nowMs));
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs });
    const cron = createService(store.storePath, {
      nowMs: () => nowMs,
    });

    const maintenance = vi.spyOn(scheduleMaintenance, "recomputeUnownedCronSchedules");
    try {
      await cron.start();
      sqliteTransactionLabels.length = 0;
      maintenance.mockClear();
      const worker = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
      try {
        await cron.status();
        await cron.list({ includeDisabled: true });
        await cron.listPage({ limit: 25 });
        await cron.readJob(jobs[0]!.id);
        expect(worker.mock.calls.length).toBe(0);
        expect(sqliteTransactionLabels).toEqual([]);
      } finally {
        worker.mockRestore();
      }
      expect(maintenance).not.toHaveBeenCalled();
    } finally {
      maintenance.mockRestore();
      cron.stop();
      await store.cleanup();
    }
  });

  it("retains one durable missing-schedule repair before the scheduler starts", async () => {
    const nowMs = Date.parse("2026-08-30T12:00:00.000Z");
    const store = await makeStorePath();
    const job = futureJob("unstarted-missing-next", nowMs, false);
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [job] });
    const cron = createService(store.storePath, {
      nowMs: () => nowMs,
    });

    const maintenance = vi.spyOn(scheduleMaintenance, "recomputeUnownedCronSchedules");
    try {
      sqliteTransactionLabels.length = 0;
      await expect(cron.readJob(job.id)).resolves.toMatchObject({
        state: { nextRunAtMs: nowMs + 60_000 },
      });
      expect(
        sqliteTransactionLabels.filter((label) => label === "cron.schedule-unowned"),
      ).toHaveLength(0);
      expect(maintenance).toHaveBeenCalledOnce();
      expect((await loadCronStore(store.storePath)).jobs[0]?.state.nextRunAtMs).toBe(
        nowMs + 60_000,
      );
    } finally {
      maintenance.mockRestore();
      cron.stop();
      await store.cleanup();
    }
  });

  it.each([
    { mode: "scheduled", status: "ok", offsets: [300_000], deleteAfterRun: true },
    { mode: "manual", status: "ok", offsets: [600_000, 1_000], deleteAfterRun: true },
  ] as const)(
    "keeps reads responsive and schedule edits across restart during a $mode $status run (deleteAfterRun=$deleteAfterRun)",
    async ({ mode, status, offsets, deleteAfterRun }) => {
      const startedAt = Date.parse("2025-12-13T00:00:01.000Z");
      const clock = createGatewaySchedulerClock(startedAt - 1_000);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const store = await makeStorePath();
      const isolatedRun = createDeferredIsolatedRun();
      const cron = createService(store.storePath, {
        scheduler,
        runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      });
      let restarted: CronService | undefined;
      let run: Promise<unknown> | undefined;
      try {
        await cron.start();
        const job = await cron.add({
          ...futureJob("edited-one-shot", clock.clock.now()),
          deleteAfterRun,
          schedule: { kind: "at", at: new Date(startedAt).toISOString() },
          delivery: { mode: "none" },
        });
        run =
          mode === "manual"
            ? cron.run(job.id, "force")
            : Promise.resolve(clock.advanceTo(startedAt));
        await isolatedRun.runStarted;
        expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledOnce();
        const running = await readResponsiveCronSnapshot(cron);
        expect(running[0]?.state.runningAtMs).toBeTypeOf("number");
        for (const offset of offsets) {
          await cron.update(job.id, {
            schedule: { kind: "at", at: new Date(startedAt - 1_000 + offset).toISOString() },
          });
        }
        isolatedRun.completeRun({
          status,
        });
        if (mode === "manual") {
          await expect(run).resolves.toEqual({ ok: true, ran: true });
        } else {
          await run;
        }
        const nextRunAtMs = startedAt - 1_000 + offsets.at(-1)!;
        const expected = {
          id: job.id,
          enabled: true,
          schedule: { kind: "at", at: new Date(nextRunAtMs).toISOString() },
          state: { lastStatus: status, nextRunAtMs },
        };
        const completed = await cron.list({ includeDisabled: true });
        expect(completed).toMatchObject([expected]);
        expect(completed[0]?.state.runningAtMs).toBeUndefined();
        cron.stop();
        restarted = createService(store.storePath, { scheduler });
        await restarted.start();
        await expect(restarted.list({ includeDisabled: true })).resolves.toMatchObject([expected]);
      } finally {
        cron.stop();
        restarted?.stop();
        await isolatedRun.settle(run);
        await store.cleanup();
      }
    },
  );

  it("keeps list and status responsive after startup defers catch-up runs", async () => {
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const store = await makeStorePath();
    const isolatedRun = createDeferredIsolatedRun();
    const cron = createService(store.storePath, {
      nowMs: () => nowMs,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      startupDeferredMissedAgentJobDelayMs: 120_000,
    });
    try {
      await writeCronStoreSnapshot({
        storePath: store.storePath,
        jobs: [
          {
            ...futureJob("startup-catchup", nowMs - 86_400_000),
            schedule: { kind: "at", at: new Date(nowMs - 60_000).toISOString() },
            delivery: { mode: "none" },
            state: { nextRunAtMs: nowMs - 60_000 },
          },
        ],
      });
      await cron.start();
      expect(isolatedRun.runIsolatedAgentJob).not.toHaveBeenCalled();

      const jobs = await readResponsiveCronSnapshot(cron);

      expect(jobs[0]?.state.lastStatus).toBeUndefined();
      expect(jobs[0]?.state.runningAtMs).toBeUndefined();
      expect(jobs[0]?.state.nextRunAtMs).toBe(nowMs + 120_000);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});

describe("CronService", () => {
  it("keeps sibling jobs when separately loaded services mutate the same partition", async () => {
    const store = await makeStorePath();
    const cronA = createService(store.storePath);
    const cronB = createService(store.storePath);
    try {
      await cronA.status();
      await cronB.status();
      const addJob = (service: CronService, id: string) =>
        service.add({
          id,
          name: id,
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: id },
        });
      await addJob(cronA, "first-cached-service-job");
      await addJob(cronB, "second-cached-service-job");
      expect((await loadCronStore(store.storePath)).jobs.map((job) => job.id)).toEqual([
        "first-cached-service-job",
        "second-cached-service-job",
      ]);
    } finally {
      cronA.stop();
      cronB.stop();
      await store.cleanup();
    }
  });

  it("avoids duplicate runs across lexical aliases of one store", async () => {
    const store = await makeStorePath();
    const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const clockA = createGatewaySchedulerClock(Date.parse("2025-12-13T00:00:00.000Z"));
    const clockB = createGatewaySchedulerClock(clockA.clock.now());

    const cronA = new CronService({
      scheduler: createTestGatewayScheduler(clockA.clock),
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob,
    });

    await cronA.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cronA.add({
      name: "shared store job",
      enabled: true,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const aliasedStorePath = `${path.dirname(store.storePath)}/../${path.basename(path.dirname(store.storePath))}/${path.basename(store.storePath)}`;

    const cronB = new CronService({
      scheduler: createTestGatewayScheduler(clockB.clock),
      storePath: aliasedStorePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob,
    });

    await cronB.start();
    expect((await cronStoreModule.loadCronStore(aliasedStorePath)).jobs).toHaveLength(1);

    await Promise.all([clockA.advanceTo(atMs), clockB.advanceTo(atMs)]);
    await cronA.status();
    await cronB.status();

    expect(runSessionEvent).toHaveBeenCalledTimes(1);

    cronA.stop();
    cronB.stop();
    await store.cleanup();
  });

  it("re-arms a stale service after a missing remove reloads an earlier job", async () => {
    const store = await makeStorePath();
    const createState = () => {
      const clock = createGatewaySchedulerClock(Date.parse("2025-12-13T00:00:00.000Z"));
      const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        scheduler: createTestGatewayScheduler(clock.clock),
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn(),
        runSessionEvent,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      return { state, runSessionEvent, clock };
    };
    const stale = createState();
    const writer = createState();
    await readStatus(stale.state);
    await readStatus(writer.state);
    const baseMs = Date.parse("2025-12-13T00:00:00.000Z");
    const addAtJob = (state: ReturnType<typeof createCronServiceState>, id: string, atMs: number) =>
      add(state, {
        id,
        name: id,
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: id },
      });

    await addAtJob(stale.state, "later-job", baseMs + 60_000);
    const staleTimer = stale.state.timer;
    await addAtJob(writer.state, "earlier-job", baseMs + 10_000);
    if (writer.state.timer) {
      writer.state.timer.cancel();
      writer.state.timer = null;
    }
    const previousRevision = cronStoreModule.getCronJobsStoreRevision(store.storePath);
    const persist = vi.spyOn(cronStoreModule, "saveCronJobsStoreWithRevision");
    persist.mockClear();

    await expect(remove(stale.state, "missing-job")).resolves.toEqual({
      ok: true,
      removed: false,
    });

    expect(persist).not.toHaveBeenCalled();
    expect(cronStoreModule.getCronJobsStoreRevision(store.storePath)).toBe(previousRevision);
    expect(stale.state.timer).not.toBe(staleTimer);
    expect(stale.state.store?.jobs.map((job) => job.id)).toEqual(["later-job", "earlier-job"]);

    await stale.clock.advanceBy(10_000);

    expect(stale.runSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "earlier-job" }),
        text: "earlier-job",
      }),
    );
    expect(stale.state.activeTimerTicks).toBe(0);
    if (stale.state.timer) {
      stale.state.timer.cancel();
    }
    await store.cleanup();
  });
});

function recurringJob(id: string, nowMs: number, nextRunAtMs: number): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs: 5 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs },
  };
}

describe("cron wakes during active execution", () => {
  it("runs later due work while an earlier scheduled run is still executing", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const started = createDeferred();
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const laterFinished = createDeferred();
    const laterJob = recurringJob("later-job", now, now + 10_000);
    laterJob.sessionTarget = "main";
    laterJob.payload = { kind: "systemEvent", text: "later work" };
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [recurringJob("long-running-job", now, now), laterJob],
    });
    const runIsolatedAgentJob = vi.fn(async () => {
      started.resolve();
      return await deferredRun.promise;
    });
    const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      scheduler,
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob,
      onEvent: (event) => {
        if (event.jobId === "later-job" && event.action === "finished") {
          laterFinished.resolve();
        }
      },
    });

    const timerPromise = onTimer(state);
    let laterWake: ReturnType<typeof clock.advanceTo> = undefined;
    try {
      await started.promise;
      expect(state.running).toBe(true);
      expect(scheduler.nextWakeAtMs).not.toBeNull();

      laterWake = clock.advanceTo(now + 10_000);
      await laterFinished.promise;

      expect(runSessionEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: "later-job" }),
          text: "later work",
        }),
      );
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.running).toBe(true);
    } finally {
      deferredRun.resolve({ status: "ok", summary: "done" });
      await timerPromise;
      await laterWake;
      stop(state);
      await scheduler.stop();
    }
    expect(state.running).toBe(false);
  });
});

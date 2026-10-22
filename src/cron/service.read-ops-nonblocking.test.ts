import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { withTimeout } from "../infra/fs-safe.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { CronService } from "./service.js";
import {
  createCronServiceWithStateForTest,
  createCronStoreHarness,
  createNoopLogger,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { getSuspensionVisibleCronTaskRunCount } from "./service/active-run-cancellation.js";
import { add, remove } from "./service/ops-mutations.js";
import { status as readStatus } from "./service/ops-read.js";
import * as scheduleMaintenance from "./service/schedule-maintenance.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import * as cronStoreModule from "./store.js";
import { loadCronStore } from "./store.js";
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

const { makeStorePath } = createCronStoreHarness();
const nowMs = Date.parse("2026-08-30T12:00:00.000Z");
let storePath: string;
beforeEach(async () => {
  ({ storePath } = await makeStorePath());
});

function createDeferredIsolatedRun() {
  const result = createDeferred<{ status: "ok"; summary?: string }>();
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

const services: CronService[] = [];

function createService(deps: Partial<CronServiceDeps> = {}, now = nowMs) {
  const clock = createGatewaySchedulerClock(now);
  const scheduler = deps.scheduler ?? createTestGatewayScheduler(clock.clock);
  const runSessionEvent =
    deps.runSessionEvent ??
    vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => ({ status: "ok" }));
  const service = createCronServiceWithStateForTest({
    scheduler,
    storePath,
    cronEnabled: true,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    runSessionEvent,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
  });
  services.push(service.cron);
  return { ...service, clock, scheduler, runSessionEvent };
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

function futureJob(id: string, createdAtMs = nowMs, withNextRun = true): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs,
    updatedAtMs: createdAtMs,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: createdAtMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: withNextRun ? { nextRunAtMs: createdAtMs + 60_000 } : {},
  };
}

function systemEventJob(id: string, schedule: CronJob["schedule"]) {
  return {
    id,
    name: id,
    enabled: true,
    schedule,
    sessionTarget: "main" as const,
    wakeMode: "next-heartbeat" as const,
    payload: { kind: "systemEvent" as const, text: id },
  };
}

describe("CronService read operations", () => {
  afterEach(() => {
    for (const cron of services.splice(0)) {
      cron.stop();
    }
    vi.restoreAllMocks();
  });
  it("publishes the scheduler's next run after a cached list and status read", async () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const { cron, state, clock, scheduler } = createService({}, now);
    try {
      await cron.start();
      const job = await cron.add(
        systemEventJob("snapshot tick", { kind: "every", everyMs: 60_000, anchorMs: now }),
      );
      const before = await cron.listPage();
      const beforeStatus = await cron.status();
      expect(before.jobs[0]?.state.nextRunAtMs).toBe(now + 60_000);
      expect(await cron.status()).toBe(beforeStatus);
      await cron.update(job.id, { name: "updated snapshot tick" });
      const updatedStatus = await cron.status();
      expect(updatedStatus).not.toBe(beforeStatus);
      expect(await cron.status()).toBe(updatedStatus);
      expect((await cron.listPage()).jobs[0]?.name).toBe("updated snapshot tick");

      clock.setTime(now + 60_000);
      await onTimer(state);

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
    }
  });

  it("keeps started read operations observational across a large stable store", async () => {
    const jobs = Array.from({ length: 100 }, (_, index) => futureJob(`stable-${index}`));
    await writeCronStoreSnapshot({ storePath, jobs });
    const { cron } = createService();

    const maintenance = vi.spyOn(scheduleMaintenance, "recomputeUnownedCronSchedules");
    await cron.start();
    await cron.status();
    sqliteTransactionLabels.length = 0;
    maintenance.mockClear();
    const worker = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
    for (const completed of [false, true]) {
      if (completed) {
        await expect(cron.run(jobs[0]!.id, "force")).resolves.toEqual({ ok: true, ran: true });
        worker.mockClear();
        sqliteTransactionLabels.length = 0;
        maintenance.mockClear();
      }
      await cron.status();
      await cron.list({ includeDisabled: true });
      const page = await cron.listPage({ limit: 25 });
      const job = await cron.readJob(jobs[0]!.id);
      expect(worker.mock.calls.length).toBe(0);
      expect(sqliteTransactionLabels).toEqual([]);
      expect(job?.state.lastStatus).toBe(completed ? "ok" : undefined);
      expect(page.jobs.find((row) => row.id === jobs[0]!.id)?.state.lastStatus).toBe(
        completed ? "ok" : undefined,
      );
    }
    expect(maintenance).not.toHaveBeenCalled();
  });

  it("retains one durable missing-schedule repair before the scheduler starts", async () => {
    const job = futureJob("unstarted-missing-next", nowMs, false);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const { cron } = createService();

    const maintenance = vi.spyOn(scheduleMaintenance, "recomputeUnownedCronSchedules");
    sqliteTransactionLabels.length = 0;
    await expect(cron.readJob(job.id)).resolves.toMatchObject({
      state: { nextRunAtMs: nowMs + 60_000 },
    });
    expect(
      sqliteTransactionLabels.filter((label) => label === "cron.schedule-unowned"),
    ).toHaveLength(0);
    expect(maintenance).toHaveBeenCalledOnce();
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(nowMs + 60_000);
  });

  it("reloads sibling jobs added while a run is executing before serving its completed view", async () => {
    await writeCronStoreSnapshot({ storePath, jobs: [futureJob("first")] });
    const { cron: sibling } = createService();
    const { cron } = createService({
      runIsolatedAgentJob: async () => {
        await sibling.add(futureJob("sibling"));
        return { status: "ok" };
      },
    });

    await cron.start();
    await cron.listPage();
    await expect(cron.run("first", "force")).resolves.toEqual({ ok: true, ran: true });
    const page = await cron.listPage();
    expect(page.jobs.map((job) => job.id)).toEqual(["first", "sibling"]);
    expect(page.jobs[0]?.state.lastStatus).toBe("ok");
    expect((await cron.status()).jobs).toBe(2);
  });

  it.each([
    { mode: "scheduled", offsets: [300_000] },
    { mode: "manual", offsets: [600_000, 1_000] },
  ] as const)(
    "keeps reads responsive and schedule edits across restart during a $mode run",
    async ({ mode, offsets }) => {
      const startedAt = Date.parse("2025-12-13T00:00:01.000Z");
      const isolatedRun = createDeferredIsolatedRun();
      const { cron, state, clock, scheduler } = createService(
        { runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob },
        startedAt - 1_000,
      );
      let restarted: CronService | undefined;
      let run: Promise<unknown> | undefined;
      try {
        await cron.start();
        const job = await cron.add({
          ...futureJob("edited-one-shot", clock.clock.now()),
          deleteAfterRun: true,
          schedule: { kind: "at", at: new Date(startedAt).toISOString() },
          delivery: { mode: "none" },
        });
        if (mode === "scheduled") {
          clock.setTime(startedAt);
        }
        run = mode === "manual" ? cron.run(job.id, "force") : onTimer(state);
        await isolatedRun.runStarted;
        expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledOnce();
        const running = await readResponsiveCronSnapshot(cron);
        expect(running[0]?.state.runningAtMs).toBeTypeOf("number");
        for (const offset of offsets) {
          await cron.update(job.id, {
            schedule: { kind: "at", at: new Date(startedAt - 1_000 + offset).toISOString() },
          });
        }
        isolatedRun.completeRun({ status: "ok" });
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
          state: { lastStatus: "ok", nextRunAtMs },
        };
        const completed = await cron.list({ includeDisabled: true });
        expect(completed).toMatchObject([expected]);
        expect(completed[0]?.state.runningAtMs).toBeUndefined();
        cron.stop();
        restarted = createService({ scheduler, nowMs: () => clock.clock.now() }).cron;
        await restarted.start();
        await expect(restarted.list({ includeDisabled: true })).resolves.toMatchObject([expected]);
      } finally {
        cron.stop();
        restarted?.stop();
        await isolatedRun.settle(run);
      }
    },
  );

  it("keeps list and status responsive after startup defers catch-up runs", async () => {
    const isolatedRun = createDeferredIsolatedRun();
    const { cron } = createService({
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      startupDeferredMissedAgentJobDelayMs: 120_000,
    });

    await writeCronStoreSnapshot({
      storePath,
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
  });
  it("keeps sibling writes visible when separately loaded services mutate and run jobs", async () => {
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => ({
      status: "ok",
    }));
    const { cron: cronA } = createService({ runSessionEvent });
    const { cron: cronB } = createService();

    await cronA.status();
    await cronB.status();
    const addJob = (service: CronService, id: string) =>
      service.add(systemEventJob(id, { kind: "every", everyMs: 60_000 }));
    await addJob(cronA, "first");
    await addJob(cronB, "second");
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["first", "second"]);
    await cronB.update("first", {
      payload: { kind: "systemEvent", text: "updated by sibling" },
    });
    await expect(cronA.run("first", "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ text: "updated by sibling" }),
    );
  });

  it("avoids duplicate runs across lexical aliases of one store", async () => {
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => ({
      status: "ok",
    }));
    const now = Date.parse("2025-12-13T00:00:00.000Z");
    const deps = { runSessionEvent };
    const first = createService(deps, now);

    await first.cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await first.cron.add({
      ...systemEventJob("shared store job", { kind: "at", at: new Date(atMs).toISOString() }),
      payload: { kind: "systemEvent", text: "hello" },
    });

    const aliasedStorePath = `${path.dirname(storePath)}/../${path.basename(path.dirname(storePath))}/${path.basename(storePath)}`;
    const second = createService({ ...deps, storePath: aliasedStorePath }, now);

    await second.cron.start();
    expect((await cronStoreModule.loadCronStore(aliasedStorePath)).jobs).toHaveLength(1);

    first.clock.setTime(atMs);
    second.clock.setTime(atMs);
    await Promise.all([onTimer(first.state), onTimer(second.state)]);
    await first.cron.status();
    await second.cron.status();

    expect(runSessionEvent).toHaveBeenCalledTimes(1);
  });

  it("re-arms a stale service after a missing remove reloads an earlier job", async () => {
    const baseMs = Date.parse("2025-12-13T00:00:00.000Z");
    const stale = createService({}, baseMs);
    const writer = createService({}, baseMs);
    await readStatus(stale.state);
    await readStatus(writer.state);
    const addAtJob = (state: typeof stale.state, id: string, atMs: number) =>
      add(state, systemEventJob(id, { kind: "at", at: new Date(atMs).toISOString() }));

    await addAtJob(stale.state, "later-job", baseMs + 60_000);
    await addAtJob(writer.state, "earlier-job", baseMs + 10_000);
    const previousRevision = cronStoreModule.getCronJobsStoreRevision(storePath);
    const persist = vi.spyOn(cronStoreModule, "saveCronJobsStoreWithRevision");
    persist.mockClear();

    await expect(remove(stale.state, "missing-job")).resolves.toEqual({
      ok: true,
      removed: false,
    });

    expect(persist).not.toHaveBeenCalled();
    expect(cronStoreModule.getCronJobsStoreRevision(storePath)).toBe(previousRevision);
    expect(stale.state.store?.jobs.map((job) => job.id)).toEqual(["later-job", "earlier-job"]);

    stale.clock.setTime(stale.clock.clock.now() + 10_000);
    await onTimer(stale.state);

    expect(stale.runSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ text: "earlier-job" }),
    );
  });
  it("runs later due work while an earlier scheduled run is still executing", async ({
    signal,
  }) => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const isolatedRun = createDeferredIsolatedRun();
    const laterFinished = createDeferred();
    const recurringJob = (id: string, nextRunAtMs: number): CronJob => ({
      ...futureJob(id, now),
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: 5 * 60_000 },
      payload: { kind: "agentTurn", message: "test" },
      delivery: { mode: "none" },
      state: { nextRunAtMs },
    });
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        recurringJob("long-running-job", now),
        {
          ...recurringJob("later-job", now + 10_000),
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "later work" },
        },
      ],
    });
    const { cron, state, clock, scheduler, runSessionEvent } = createService(
      {
        runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
        onEvent: (event) => {
          if (event.jobId === "later-job" && event.action === "finished") {
            laterFinished.resolve();
          }
        },
      },
      now,
    );

    const jobState = (id: string) => state.store?.jobs.find((job) => job.id === id)?.state;
    const timerPromise = onTimer(state);
    let laterWake: Promise<void> | undefined;
    try {
      await withinTest(isolatedRun.runStarted, signal);
      expect(jobState("long-running-job")?.runningAtMs).toBe(now);
      expect(jobState("later-job")?.nextRunAtMs).toBe(now + 10_000);

      clock.setTime(now + 10_000);
      laterWake = onTimer(state);
      await withinTest(laterFinished.promise, signal);

      expect(runSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ text: "later work" }));
      expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(jobState("long-running-job")?.runningAtMs).toBe(now);
    } finally {
      isolatedRun.completeRun({ status: "ok", summary: "done" });
      await timerPromise;
      await laterWake;
      cron.stop();
      await scheduler.stop();
    }
    expect(jobState("long-running-job")?.runningAtMs).toBeUndefined();
  });
});

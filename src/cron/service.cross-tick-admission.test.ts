import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import * as cron from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as work from "../process/gateway-work-admission.js";
import * as clocks from "../test-utils/gateway-scheduler-clock.js";
import { start, stop } from "./service/ops-lifecycle.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import { startCronScheduler } from "./service/scheduler-actor.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import type { CronJob } from "./types.js";

const fixtures = cron.setupCronRegressionFixtures({ prefix: "cron-cross-tick-" });

function dueJob(id: string, nowMs: number, nextRunAtMs = nowMs) {
  return cron.createDueIsolatedJob({ id, nowMs, nextRunAtMs });
}

async function seedJobs(jobs: CronJob[]) {
  const store = fixtures.makeStorePath();
  await saveCronStore(store.storePath, { version: 1, jobs });
  return {
    ...store,
    receipt: (job: CronJob) =>
      inspectActiveCronRunReceipt({ storePath: store.storePath, jobId: job.id }),
  };
}

function blockedJob(id: string, nowMs: number, nextRunAtMs: number) {
  return {
    job: dueJob(id, nowMs, nextRunAtMs),
    started: createDeferred(),
    result: createDeferred(),
  };
}

afterEach(work.resetGatewayWorkAdmission);

it("runs the next future wake under its own Gateway root while an earlier batch runs", async () => {
  const t0 = Date.now();
  const clock = clocks.createGatewaySchedulerClock(t0);
  const scheduler = clocks.createTestGatewayScheduler(clock.clock);
  const a = blockedJob("timer-a", t0, t0 + 1_000);
  a.job.payload = { kind: "agentTurn", message: a.job.id, timeoutSeconds: 0 };
  const b = blockedJob("timer-b", t0, t0 + 1_500);
  const store = await seedJobs([a.job, b.job]);
  const run = async ({ job }: { job: CronJob }) => {
    const gate = expectDefined(
      [a, b].find((entry) => entry.job.id === job.id),
      `unexpected ${job.id}`,
    );
    gate.started.resolve();
    await gate.result.promise;
    return { status: "ok" as const, summary: job.id };
  };
  const state = cron.createCronRegressionState({
    scheduler,
    storePath: store.storePath,
    nowMs: clock.clock.now,
    runIsolatedAgentJob: run,
  });

  const { wake } = await captureCronSchedulerWakeForTest(() =>
    startCronScheduler(state, new Set()),
  );
  clock.setTime(t0 + 1_000);
  const tickA = wake(state);
  let tickB: Promise<void> | undefined;
  try {
    await a.started.promise;
    await tickA;
    expect(store.receipt(b.job)).toBeUndefined();
    clock.setTime(t0 + 1_500);
    tickB = wake(state);
    await b.started.promise;
    await tickB;

    expect(store.receipt(b.job)).toBeDefined();
    expect(work.getActiveGatewayRootWorkHolders()).toEqual(["cron:run (2)"]);

    a.result.resolve();
    b.result.resolve();
    await waitForCronRunQueue(state);
    expect(work.getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    a.result.resolve();
    b.result.resolve();
    await Promise.all([tickA, tickB]);
    stop(state);
    await scheduler.stop();
  }
});
it("retires a suspended timer across a scheduler stop and restart", async () => {
  let nowMs = Date.parse("2026-02-06T10:08:00.000Z");
  const job = dueJob("retired-scheduler-timer", nowMs, nowMs + 1_000);
  const store = await seedJobs([job]);

  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const state = cron.createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => nowMs,
    runIsolatedAgentJob,
  });
  const { wake } = await captureCronSchedulerWakeForTest(() => start(state));
  const restartSignal = work.beginGatewayRestartSignalAdmission();
  expect(restartSignal).not.toBeNull();
  const retiredTimer = wake(state);

  try {
    stop(state);
    await retiredTimer;
    await start(state);
    nowMs += 1_000;

    expect(restartSignal?.rollback()).toBe(true);
    await retiredTimer;

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(work.getActiveGatewayRootWorkCount()).toBe(0);
    const persisted = (await loadCronStore(store.storePath)).jobs[0]?.state;
    expect(persisted?.nextRunAtMs).toBe(nowMs);
    expect(persisted?.queuedAtMs).toBeUndefined();
    expect(persisted?.runningAtMs).toBeUndefined();
  } finally {
    restartSignal?.rollback();
    stop(state);
    await retiredTimer;
  }
});

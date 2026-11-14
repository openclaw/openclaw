import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import * as cron from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as work from "../process/gateway-work-admission.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import * as clocks from "../test-utils/gateway-scheduler-clock.js";
import { createTestCronOperatorSource } from "./execution-context.test-support.js";
import { handOver, start, stop } from "./service/ops-lifecycle.js";
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

it("keeps a queued condition check pending through a graceful shutdown and restart", async () => {
  let nowMs = Date.parse("2026-02-06T10:08:00.000Z");
  const dueAtMs = nowMs + 1_000;
  const jobs = ["w1", "w2", "w3", "waiter"].map((id) =>
    Object.assign(dueJob(id, nowMs, dueAtMs), {
      schedule: { kind: "every" as const, everyMs: 300_000, anchorMs: dueAtMs },
      trigger: { script: "return { fire: false }" },
    }),
  );
  const store = await seedJobs(jobs);
  const release = createDeferred();
  const evaluated: string[] = [];
  const boot = () =>
    cron.createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => nowMs,
      cronConfig: { triggers: { enabled: true } },
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      evaluateCronTrigger: async ({ job }) => {
        evaluated.push(job.id);
        await release.promise;
        return { kind: "evaluated", fire: false };
      },
    });
  const waiter = async () =>
    (await loadCronStore(store.storePath)).jobs.find((job) => job.id === "waiter")?.state;
  const first = boot();
  const running = await captureCronSchedulerWakeForTest(() => start(first));
  nowMs = dueAtMs;
  await running.wake(first);
  await vi.waitFor(() => expect(evaluated).toEqual(["w1", "w2", "w3"]));

  // Shutdown closes admission, then the active checks end and free their places.
  work.markGatewayRestartDraining("stop (SIGTERM)");
  release.resolve();
  await waitForCronRunQueue(first);
  stop(first);
  await first.schedulerDrain;
  expect(evaluated).toEqual(["w1", "w2", "w3"]);
  expect(await waiter()).toMatchObject({ nextRunAtMs: dueAtMs, queuedAtMs: dueAtMs });

  work.resetGatewayWorkAdmission();
  const second = boot();
  try {
    // The fresh process resumes the same occurrence instead of moving to the next interval.
    await start(second);
    await vi.waitFor(() => expect(evaluated).toEqual(["w1", "w2", "w3", "waiter"]));
    await waitForCronRunQueue(second);
    expect(await waiter()).toMatchObject({
      lastTriggerEvalAtMs: dueAtMs,
      nextRunAtMs: dueAtMs + 300_000,
    });
  } finally {
    stop(second);
  }
});

it.each([true, false])(
  "checks other watchers while in-conversation watchers wait for their busy conversation (operator source: %s)",
  async (withOperatorSource) => {
    let nowMs = Date.parse("2026-02-06T10:08:00.000Z");
    const dueAtMs = nowMs + 1_000;
    const conversation = "agent:main:busy-conversation";
    const jobs = ["c1", "c2", "c3", "free"].map((id) =>
      Object.assign(dueJob(id, nowMs, dueAtMs), {
        schedule: { kind: "every" as const, everyMs: 300_000, anchorMs: dueAtMs },
        trigger: { script: "return { fire: false }" },
        ...(id === "free"
          ? {}
          : {
              sessionTarget: `session:${conversation}`,
              ...(withOperatorSource
                ? { operatorSource: createTestCronOperatorSource(conversation) }
                : {}),
            }),
      }),
    );
    const store = await seedJobs(jobs);
    const turn = createReplyOperation({
      sessionKey: conversation,
      sessionId: "parent-session",
      resetTriggered: false,
      turnKind: "visible",
    });
    const evaluated: string[] = [];
    const state = cron.createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => nowMs,
      cronConfig: { triggers: { enabled: true } },
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      evaluateCronTrigger: async ({ job }) => {
        evaluated.push(job.id);
        return { kind: "evaluated", fire: false };
      },
    });
    const running = await captureCronSchedulerWakeForTest(() => start(state));
    try {
      nowMs = dueAtMs;
      await running.wake(state);
      await vi.waitFor(() => expect(evaluated).toEqual(["free"]));
      // The three waiters stay queued: no running marker, so no run slot and no check.
      const waiting = (await loadCronStore(store.storePath)).jobs.filter(
        (job) => job.id !== "free",
      );
      expect(waiting.map((job) => job.state.runningAtMs)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);

      turn.complete();
      await vi.waitFor(() => expect(evaluated.toSorted()).toEqual(["c1", "c2", "c3", "free"]));
    } finally {
      turn.complete();
      await waitForCronRunQueue(state);
      stop(state);
    }
  },
);

it("queues a source-less one-shot for its busy session before launching the session event", async () => {
  let nowMs = Date.parse("2026-02-06T10:08:00.000Z");
  const dueAtMs = nowMs + 1_000;
  const conversation = "agent:main:busy-conversation";
  const job = Object.assign(dueJob("session-check", nowMs, dueAtMs), {
    schedule: { kind: "at" as const, at: new Date(dueAtMs).toISOString() },
    sessionTarget: `session:${conversation}`,
    payload: { kind: "agentTurn" as const, message: "Check the pending work." },
  });
  const store = await seedJobs([job]);
  const turn = createReplyOperation({
    sessionKey: conversation,
    sessionId: "parent-session",
    resetTriggered: false,
    turnKind: "visible",
  });
  const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
  const state = cron.createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => nowMs,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    runSessionEvent,
  });
  const running = await captureCronSchedulerWakeForTest(() => start(state));
  try {
    nowMs = dueAtMs;
    await running.wake(state);
    expect(runSessionEvent).not.toHaveBeenCalled();

    turn.complete();
    await vi.waitFor(() => expect(runSessionEvent).toHaveBeenCalledOnce());
    await waitForCronRunQueue(state);
  } finally {
    turn.complete();
    await waitForCronRunQueue(state);
    stop(state);
  }
});

it("checks conditions while every run slot is busy and runs a fired payload when one frees", async () => {
  let nowMs = Date.parse("2026-02-06T10:08:00.000Z");
  const dueAtMs = nowMs + 1_000;
  const longs = Array.from({ length: 8 }, (_, index) => dueJob(`long-${index}`, nowMs, dueAtMs));
  const watchers = ["quiet", "fires"].map((id) =>
    Object.assign(dueJob(id, nowMs, dueAtMs), {
      schedule: { kind: "every" as const, everyMs: 300_000, anchorMs: dueAtMs },
      trigger: { script: "return { fire: true }" },
    }),
  );
  const store = await seedJobs([...longs, ...watchers]);
  const release = createDeferred();
  const finish = createDeferred();
  const started: string[] = [];
  const evaluated: string[] = [];
  const state = cron.createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => nowMs,
    cronConfig: { triggers: { enabled: true } },
    runIsolatedAgentJob: async ({ job }: { job: CronJob }) => {
      started.push(job.id);
      if (job.id.startsWith("long-")) {
        await (job.id === "long-0" ? release : finish).promise;
      }
      return { status: "ok" as const, summary: job.id };
    },
    evaluateCronTrigger: async ({ job }) => {
      evaluated.push(job.id);
      return { kind: "evaluated", fire: job.id === "fires" };
    },
  });
  const running = await captureCronSchedulerWakeForTest(() => start(state));
  const fires = async () =>
    (await loadCronStore(store.storePath)).jobs.find((job) => job.id === "fires")?.state;
  try {
    nowMs = dueAtMs;
    await running.wake(state);
    // Eight payloads hold every run slot; both conditions are checked all the same.
    await vi.waitFor(() => expect(evaluated).toEqual(["quiet", "fires"]));
    expect(started.toSorted()).toEqual(longs.map((job) => job.id).toSorted());
    // The fired condition waits for a run slot, holding neither a slot nor a check.
    await vi.waitFor(async () =>
      expect((await fires())?.runSlotWaitReceiptId).toEqual(expect.any(String)),
    );
    expect((await fires())?.conditionCheckReceiptId).toBeUndefined();
    expect(started).not.toContain("fires");

    // A slot frees: the payload runs on the result of the one check.
    release.resolve();
    await vi.waitFor(() => expect(started).toContain("fires"));
    expect(evaluated).toEqual(["quiet", "fires"]);
  } finally {
    release.resolve();
    finish.resolve();
    await waitForCronRunQueue(state);
    stop(state);
  }
});

it.each([
  ["a cron config reload keeps", true],
  ["a stop ends", false],
])("%s a fired condition's wait for a run slot", async (_name, reload) => {
  let nowMs = Date.parse("2026-02-06T10:08:00.000Z");
  const dueAtMs = nowMs + 1_000;
  const longs = Array.from({ length: 8 }, (_, index) => dueJob(`long-${index}`, nowMs, dueAtMs));
  const watcher = Object.assign(dueJob("fires", nowMs, dueAtMs), {
    schedule: { kind: "every" as const, everyMs: 300_000, anchorMs: dueAtMs },
    trigger: { script: "return { fire: true }" },
  });
  const store = await seedJobs([...longs, watcher]);
  const release = createDeferred();
  const finish = createDeferred();
  const started: string[] = [];
  const deps = {
    storePath: store.storePath,
    nowMs: () => nowMs,
    cronConfig: { triggers: { enabled: true } },
    runIsolatedAgentJob: async ({ job }: { job: CronJob }) => {
      started.push(job.id);
      if (job.id.startsWith("long-")) {
        await (job.id === "long-0" ? release : finish).promise;
      }
      return { status: "ok" as const, summary: job.id };
    },
    evaluateCronTrigger: async () => ({ kind: "evaluated" as const, fire: true }),
  };
  const state = cron.createCronRegressionState(deps);
  const replacement = cron.createCronRegressionState(deps);
  const running = await captureCronSchedulerWakeForTest(() => start(state));
  try {
    nowMs = dueAtMs;
    await running.wake(state);
    await vi.waitFor(async () =>
      expect(
        (await loadCronStore(store.storePath)).jobs.find((job) => job.id === "fires")?.state
          .runSlotWaitReceiptId,
      ).toEqual(expect.any(String)),
    );

    // After a reload the replacement hands the waiting payload a slot once one frees.
    if (reload) {
      handOver(state);
      await start(replacement);
    } else {
      stop(state);
    }
    release.resolve();
    finish.resolve();
    await waitForCronRunQueue(state);
    expect(started.includes("fires")).toBe(reload);
  } finally {
    release.resolve();
    finish.resolve();
    await waitForCronRunQueue(state);
    stop(state);
    stop(replacement);
  }
});

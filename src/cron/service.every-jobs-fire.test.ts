// Every-job firing tests cover repeated schedule execution semantics.
import { describe, expect, it, vi } from "vitest";
import { prepareGatewaySuspend } from "../infra/gateway-suspend-coordinator.js";
import {
  beginGatewayRestartSignalAdmission,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

async function startEveryJob(text: string) {
  const store = await makeStorePath();
  const logger = createNoopLogger();
  const clock = createGatewaySchedulerClock(Date.now());
  const fixture = createStartedCronServiceWithFinishedBarrier({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    logger,
  });
  const { wake } = await captureCronSchedulerWakeForTest(() => fixture.cron.start());
  const job = await fixture.cron.add({
    name: text,
    enabled: true,
    schedule: { kind: "every", everyMs: 10_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text },
  });
  return { ...fixture, store, logger, clock, job, wake };
}

describe("CronService interval/cron jobs fire on time", () => {
  const expectMainSessionTurn = (
    runSessionEvent: ReturnType<typeof vi.fn>,
    expectedText: string,
  ) => {
    const matchingCall = runSessionEvent.mock.calls.find(
      ([request]) => request.text === expectedText,
    );
    if (!matchingCall) {
      throw new Error(`missing system event ${expectedText}`);
    }
    expect(matchingCall[0].job.sessionTarget).toBe("main");
  };

  it("resumes due cron work after a busy suspension attempt", async () => {
    const { cron, state, runSessionEvent, finished, store, clock, job, wake } =
      await startEveryJob("recovered-tick");
    resetGatewayWorkAdmission();

    try {
      expect(
        prepareGatewaySuspend({
          requestId: "cron-resume-retry",
          pauseScheduling: () => cron.pauseScheduling(),
          resumeScheduling: () => cron.resumeScheduling(),
          inspect: { getQueueSize: () => 1 },
        }),
      ).toMatchObject({ status: "busy" });
      expect(isGatewayWorkAdmissionClosed()).toBe(false);

      const finishedRun = finished.waitForOk(job.id);
      clock.setTime(job.state.nextRunAtMs! + 5);
      await wake(state);
      await finishedRun;
      await waitForCronRunQueue(state);
      expectMainSessionTurn(runSessionEvent, "recovered-tick");
    } finally {
      cron.stop();
      resetGatewayWorkAdmission();
      await store.cleanup();
    }
  });

  it("keeps a due timer pending when restart signal admission rolls back", async () => {
    const {
      cron,
      state,
      runSessionEvent,
      finished,
      store,
      clock,
      job,
      wake: wakeScheduler,
    } = await startEveryJob("rollback-tick");
    resetGatewayWorkAdmission();
    let wake: Promise<void> | undefined;

    try {
      const pendingSignal = beginGatewayRestartSignalAdmission();
      expect(pendingSignal).not.toBeNull();
      const finishedRun = finished.waitForOk(job.id);
      clock.setTime(job.state.nextRunAtMs! + 5);
      wake = wakeScheduler(state);
      expect(runSessionEvent).not.toHaveBeenCalled();

      expect(pendingSignal?.rollback()).toBe(true);
      await wake;
      await finishedRun;
      await waitForCronRunQueue(state);
      expectMainSessionTurn(runSessionEvent, "rollback-tick");
    } finally {
      cron.stop();
      resetGatewayWorkAdmission();
      await wake;
      await store.cleanup();
    }
  });

  it("keeps every jobs due while minute cron jobs recompute schedules", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const runSessionEvent = vi.fn(async (_params: { text: string }) => ({ status: "ok" as const }));
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const clock = createGatewaySchedulerClock(nowMs);

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          id: "loaded-every",
          text: "sf-tick",
          schedule: { kind: "every" as const, everyMs: 120_000 },
          dueInMs: 120_000,
        },
        {
          id: "minute-cron",
          text: "minute-tick",
          schedule: { kind: "cron" as const, expr: "* * * * *", tz: "UTC" },
          dueInMs: 60_000,
        },
      ].map(({ id, text, schedule, dueInMs }) => ({
        id,
        name: id,
        enabled: true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        schedule,
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text },
        state: { nextRunAtMs: nowMs + dueInMs },
      })),
    });

    const cron = new CronService({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      runSessionEvent,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    // Perf: a few recomputation cycles are enough to catch "every" drift.
    for (let minute = 1; minute <= 3; minute++) {
      clock.setTime(nowMs + minute * 60_000);
      const minuteRun = await cron.run("minute-cron", "force");
      expect(minuteRun).toEqual({ ok: true, ran: true });
    }

    // "every" cadence is 2m; verify it stays due at the 6-minute boundary.
    clock.setTime(nowMs + 6 * 60_000);
    const sfRun = await cron.run("loaded-every", "due");
    expect(sfRun).toEqual({ ok: true, ran: true });

    const sfRuns = runSessionEvent.mock.calls.filter(
      ([request]) => request.text === "sf-tick",
    ).length;
    const minuteRuns = runSessionEvent.mock.calls.filter(
      ([request]) => request.text === "minute-tick",
    ).length;
    expect(minuteRuns).toBeGreaterThan(0);
    expect(sfRuns).toBeGreaterThan(0);

    const jobs = await cron.list({ includeDisabled: true });
    const sfJob = jobs.find((job) => job.id === "loaded-every");
    expect(sfJob?.state.lastStatus).toBe("ok");
    expect(sfJob?.schedule.kind).toBe("every");
    expect(sfJob?.state.nextRunAtMs).toBe(nowMs + 8 * 60_000);

    cron.stop();
    await store.cleanup();
  });
});

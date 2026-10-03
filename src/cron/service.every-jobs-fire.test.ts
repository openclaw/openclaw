// Every-job firing tests cover repeated schedule execution semantics.
import { describe, expect, it, vi } from "vitest";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
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
  await fixture.cron.start();
  const job = await fixture.cron.add({
    name: text,
    enabled: true,
    schedule: { kind: "every", everyMs: 10_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text },
  });
  return { ...fixture, store, logger, clock, job };
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
    expect(matchingCall[0].job.agentId).toBe("main");
    expect(matchingCall[0].job.sessionTarget).toBe("main");
  };

  it("keeps admission closed until a real cron scheduler resume retry succeeds", async () => {
    const { cron, runSessionEvent, finished, store, clock, job, logger } =
      await startEveryJob("recovered-tick");
    resetGatewayWorkAdmission();

    try {
      logger.debug.mockImplementationOnce(() => {
        throw new Error("arm failed");
      });

      expect(
        prepareGatewaySuspend({
          requestId: "cron-resume-retry",
          pauseScheduling: () => cron.pauseScheduling(),
          resumeScheduling: () => cron.resumeScheduling(),
          inspect: { getQueueSize: () => 1 },
        }),
      ).toMatchObject({ status: "recovering" });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);

      await clock.advanceBy(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getGatewaySuspendStatus("stale-id")).toEqual({ status: "running" });
      expect(isGatewayWorkAdmissionClosed()).toBe(false);

      const finishedRun = finished.waitForOk(job.id);
      await clock.advanceBy(9_005);
      await finishedRun;
      expectMainSessionTurn(runSessionEvent, "recovered-tick");
    } finally {
      cron.stop();
      resetGatewayWorkAdmission();
      await store.cleanup();
    }
  });

  it("keeps a due timer pending when restart signal admission rolls back", async () => {
    const { cron, runSessionEvent, finished, store, clock, job } =
      await startEveryJob("rollback-tick");
    resetGatewayWorkAdmission();
    let wake: ReturnType<typeof clock.advanceBy> = undefined;

    try {
      const pendingSignal = beginGatewayRestartSignalAdmission();
      expect(pendingSignal).not.toBeNull();
      const finishedRun = finished.waitForOk(job.id);
      wake = clock.advanceBy(10_005);
      expect(runSessionEvent).not.toHaveBeenCalled();

      expect(pendingSignal?.rollback()).toBe(true);
      await finishedRun;
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

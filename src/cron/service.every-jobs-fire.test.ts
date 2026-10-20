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
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite();

async function startEveryJob(text: string) {
  const store = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const fixture = createStartedCronServiceWithFinishedBarrier({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    logger: noopLogger,
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
  return { ...fixture, store, clock, job, wake };
}

describe("CronService interval/cron jobs fire on time", () => {
  it.each([
    ["busy suspension attempt", "recovered-tick"],
    ["restart signal admission rollback", "rollback-tick"],
  ])("resumes due cron work after %s", async (variant, text) => {
    const fixture = await startEveryJob(text);
    const { cron, state, enqueueSystemEvent, finished, store, clock, job } = fixture;
    resetGatewayWorkAdmission();
    let wake: Promise<void> | undefined;

    try {
      let pendingSignal: ReturnType<typeof beginGatewayRestartSignalAdmission> | undefined;
      if (variant === "restart signal admission rollback") {
        pendingSignal = beginGatewayRestartSignalAdmission();
        expect(pendingSignal).not.toBeNull();
      } else {
        expect(
          prepareGatewaySuspend({
            requestId: "cron-resume-retry",
            pauseScheduling: () => cron.pauseScheduling(),
            resumeScheduling: () => cron.resumeScheduling(),
            inspect: { getQueueSize: () => 1 },
          }),
        ).toMatchObject({ status: "busy" });
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
      }
      const finishedRun = finished.waitForOk(job.id);
      clock.setTime(job.state.nextRunAtMs! + 5);
      wake = fixture.wake(state);
      if (variant === "restart signal admission rollback") {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(pendingSignal?.rollback()).toBe(true);
      }
      await wake;
      await finishedRun;
      await waitForCronRunQueue(state);
      const options = enqueueSystemEvent.mock.calls.find(([actual]) => actual === text)?.[1];
      expect(options).toMatchObject({
        agentId: "main",
        contextKey: expect.stringMatching(/^cron:/),
      });
      expect(options?.sessionKey).toBeUndefined();
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
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const clock = createGatewaySchedulerClock(nowMs);

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: (
        [
          ["loaded-every", "sf-tick", { kind: "every", everyMs: 120_000 }, 120_000],
          ["minute-cron", "minute-tick", { kind: "cron", expr: "* * * * *", tz: "UTC" }, 60_000],
        ] as const
      ).map(([id, text, schedule, dueInMs]) => ({
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
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    for (let minute = 1; minute <= 3; minute++) {
      clock.setTime(nowMs + minute * 60_000);
      expect(await cron.run("minute-cron", "force")).toEqual({ ok: true, ran: true });
    }

    // "every" cadence is 2m; verify it stays due at the 6-minute boundary.
    clock.setTime(nowMs + 6 * 60_000);
    expect(await cron.run("loaded-every", "due")).toEqual({ ok: true, ran: true });

    expect(enqueueSystemEvent.mock.calls.some(([text]) => text === "minute-tick")).toBe(true);
    expect(enqueueSystemEvent.mock.calls.some(([text]) => text === "sf-tick")).toBe(true);

    const jobs = await cron.list({ includeDisabled: true });
    const sfJob = jobs.find((job) => job.id === "loaded-every");
    expect(sfJob).toMatchObject({
      schedule: { kind: "every" },
      state: { lastStatus: "ok", nextRunAtMs: nowMs + 8 * 60_000 },
    });

    cron.stop();
    await store.cleanup();
  });
});

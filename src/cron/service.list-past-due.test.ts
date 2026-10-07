import { describe, expect, it } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-16156-",
  fakeTimers: false,
});

describe("#16156: cron.list() must not silently advance past-due recurring jobs", () => {
  it("does not skip a cron job when list() is called while the job is past-due", async () => {
    const store = await makeStorePath();
    const clock = createGatewaySchedulerClock(Date.parse("2025-12-13T00:00:00.000Z"));
    const { cron, runSessionEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();

    const job = await cron.add({
      name: "every-minute",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "cron-tick" },
    });

    const firstDueAt = job.state.nextRunAtMs!;
    expect(firstDueAt).toBe(Date.parse("2025-12-13T00:01:00.000Z"));

    clock.setTime(firstDueAt + 5);

    const listedBefore = await cron.list({ includeDisabled: true });
    const jobBeforeTimer = listedBefore.find((j) => j.id === job.id);

    expect(jobBeforeTimer?.state.nextRunAtMs).toBe(firstDueAt);

    const finishedRun = finished.waitForOk(job.id);
    await clock.wake();
    await finishedRun;

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);

    expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: "cron-tick",
        job: expect.objectContaining({ id: job.id, sessionTarget: "main" }),
      }),
    );
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(firstDueAt);

    cron.stop();
  });
});

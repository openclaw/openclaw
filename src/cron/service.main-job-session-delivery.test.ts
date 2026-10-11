import { describe, expect, it } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-main-session-delivery" });

describe("cron main job session delivery", () => {
  it("passes the owned conversation to ordinary session execution for immediate jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const clock = createGatewaySchedulerClock(now);
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "main-delivery",
          agentId: "main",
          name: "main-delivery",
          enabled: true,
          createdAtMs: now - 10_000,
          updatedAtMs: now - 10_000,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "Check in" },
          state: { nextRunAtMs: now - 1 },
        },
      ],
    });
    const { cron, finished, enqueueSystemEvent, runSessionEvent } =
      createStartedCronServiceWithFinishedBarrier({
        scheduler: createTestGatewayScheduler(clock.clock),
        storePath,
        logger,
      });
    const terminal = finished.waitForOk("main-delivery");
    try {
      await cron.start();
      const job = cron.getJob("main-delivery");
      if (job?.state.lastRunAtMs === undefined) {
        expect(job?.state.nextRunAtMs).toBeTypeOf("number");
        await clock.advanceTo(job!.state.nextRunAtMs!);
      }
      await terminal;
      expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          job: expect.objectContaining({
            id: "main-delivery",
            agentId: "main",
            sessionTarget: "main",
          }),
          text: "Check in",
        }),
      );
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      cron.stop();
    }
  });
});

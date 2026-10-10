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

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-main-heartbeat-target" });

describe("cron main job passes heartbeat target=last", () => {
  it("preserves the last target for immediate wakes", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const clock = createGatewaySchedulerClock(now);
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "main-delivery",
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
    const { cron, finished, requestHeartbeatAndWait } = createStartedCronServiceWithFinishedBarrier(
      {
        scheduler: createTestGatewayScheduler(clock.clock),
        storePath,
        logger,
        requestHeartbeatAndWait: async () => ({ status: "ran", durationMs: 50 }),
      },
    );
    const terminal = finished.waitForOk("main-delivery");
    try {
      await cron.start();
      const job = cron.getJob("main-delivery");
      if (job?.state.lastRunAtMs === undefined) {
        expect(job?.state.nextRunAtMs).toBeTypeOf("number");
        await clock.advanceTo(job!.state.nextRunAtMs!);
      }
      await terminal;
      expect(requestHeartbeatAndWait).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source: "cron",
          intent: "immediate",
          reason: "cron:main-delivery",
          agentId: "main",
          heartbeat: { target: "last" },
        }),
        expect.any(Object),
      );
      expect(requestHeartbeatAndWait.mock.calls[0]?.[0].sessionKey).toBeUndefined();
    } finally {
      cron.stop();
    }
  });
});

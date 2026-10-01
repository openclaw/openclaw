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
  it.each(["now", "next-heartbeat"] as const)(
    "preserves the last target for %s wakes",
    async (wakeMode) => {
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
            wakeMode,
            payload: { kind: "systemEvent", text: "Check in" },
            state: { nextRunAtMs: now - 1 },
          },
        ],
      });
      const { cron, finished, enqueueSystemEvent, requestHeartbeat, requestHeartbeatAndWait } =
        createStartedCronServiceWithFinishedBarrier({
          scheduler: createTestGatewayScheduler(clock.clock),
          storePath,
          logger,
          requestHeartbeatAndWait: async () => ({ status: "ran", durationMs: 50 }),
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
        const request = wakeMode === "now" ? requestHeartbeatAndWait : requestHeartbeat;
        expect(request).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            source: "cron",
            intent: wakeMode === "now" ? "immediate" : "event",
            reason: "cron:main-delivery",
            agentId: "main",
            heartbeat: { target: "last" },
          }),
          ...(wakeMode === "now" ? [expect.any(Object)] : []),
        );
        expect(request.mock.calls[0]?.[0].sessionKey).toBeUndefined();
        if (wakeMode === "next-heartbeat") {
          expect(requestHeartbeatAndWait).not.toHaveBeenCalled();
          expect(enqueueSystemEvent.mock.calls[0]?.[1]?.agentId).toBe("main");
          expect(enqueueSystemEvent.mock.calls[0]?.[1]?.sessionKey).toBeUndefined();
        }
      } finally {
        cron.stop();
      }
    },
  );
});

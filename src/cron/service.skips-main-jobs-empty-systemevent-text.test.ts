import { expect, it } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { setupCronServiceSuite, withCronServiceForTest } from "./service.test-harness.js";
import { onTimer } from "./service/timer.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite();

it("rejects empty task prompts before persisting or executing them", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  await withCronServiceForTest(
    {
      scheduler: createTestGatewayScheduler(clock.clock),
      makeStorePath,
      logger,
      cronEnabled: true,
    },
    async ({ cron, state, enqueueSystemEvent, runSessionEvent }) => {
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await expect(
        cron.add({
          name: "empty event",
          enabled: true,
          schedule: { kind: "at", at: new Date(atMs).toISOString() },
          sessionTarget: "session:agent:main:main",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "   " },
        }),
      ).rejects.toThrow("cannot project invalid cron job");
      await clock.advanceTo(atMs);
      await onTimer(state);
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(await cron.list({ includeDisabled: true })).toEqual([]);
    },
  );
});

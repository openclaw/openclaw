import { expect, it } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { setupCronServiceSuite, withCronServiceForTest } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite();

it("disables persisted main jobs with empty systemEvent text after skipping them", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  await withCronServiceForTest(
    {
      scheduler: createTestGatewayScheduler(clock.clock),
      makeStorePath,
      logger,
      cronEnabled: true,
    },
    async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await cron.add({
        name: "empty event",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "   " },
      });
      await clock.advanceTo(atMs);
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
      const [job] = await cron.list({ includeDisabled: true });
      expect(job?.enabled).toBe(false);
      expect(job?.state.lastStatus).toBe("skipped");
      expect(job?.state.lastError).toMatch(/non-empty/i);
      expect(job?.state.nextRunAtMs).toBeUndefined();
    },
  );
});

import { expect, it } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunStateForTests } from "./run-history.test-support.js";
import { setupCronServiceSuite, withCronServiceForTest } from "./service.test-harness.js";
import { onTimer } from "./service/timer.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite();

it("records the skip and retires one-shot main jobs with empty systemEvent text", async () => {
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
      const job = await cron.add({
        name: "empty event",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "   " },
      });
      await clock.advanceTo(atMs);
      await onTimer(state);
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(await cron.list({ includeDisabled: true })).toEqual([]);
      expect(readCronRunStateForTests(job.id)).toMatchObject({
        lastRunStatus: "skipped",
        lastError: expect.stringMatching(/non-empty/i),
      });
    },
  );
});

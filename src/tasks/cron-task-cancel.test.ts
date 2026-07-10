import { describe, expect, it, vi } from "vitest";
import {
  CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS,
  resetActiveCronTaskRunsForTests,
  retireActiveCronTaskRunTracking,
  startActiveCronTaskRunSettlementGrace,
  trackActiveCronTaskRunSettlement,
  waitForActiveCronTaskRuns,
} from "./cron-task-cancel.js";

describe("cron task cancellation tracking", () => {
  it("retires never-settling cron promises at lifecycle cutoff", async () => {
    resetActiveCronTaskRunsForTests();
    trackActiveCronTaskRunSettlement(new Promise<never>(() => {}));

    await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
      drained: false,
      active: 1,
    });

    retireActiveCronTaskRunTracking();

    await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
      drained: true,
      active: 0,
    });
  });

  it("drops never-settling cron promises after a bounded grace period", async () => {
    vi.useFakeTimers();
    try {
      resetActiveCronTaskRunsForTests();
      trackActiveCronTaskRunSettlement(new Promise<never>(() => {}));

      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
        drained: false,
        active: 1,
      });

      await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);

      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
        drained: false,
        active: 1,
      });

      startActiveCronTaskRunSettlementGrace();
      await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);

      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
        drained: true,
        active: 0,
      });
    } finally {
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });
});

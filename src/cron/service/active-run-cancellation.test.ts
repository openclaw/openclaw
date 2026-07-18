import { describe, expect, it, vi } from "vitest";
import {
  getSuspensionVisibleCronTaskRunCount,
  retireActiveCronTaskRunTracking,
  startActiveCronTaskRunSettlementGrace,
  trackActiveCronTaskRunSettlement,
  waitForActiveCronTaskRuns,
} from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";

const CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS = 60_000;

describe("cron task cancellation tracking", () => {
  it("retires restart tracking while keeping an unsettled core suspension-visible", async () => {
    resetActiveCronTaskRunsForTests();
    let settle = () => {};
    const core = new Promise<void>((resolve) => {
      settle = resolve;
    });
    trackActiveCronTaskRunSettlement(core);

    await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
      drained: false,
      active: 1,
    });
    expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);

    retireActiveCronTaskRunTracking();

    await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
      drained: true,
      active: 0,
    });
    expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);

    settle();
    await core;
    await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
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
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
    } finally {
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });

  it("keeps suspension blocked until a timed-out core actually settles", async () => {
    resetActiveCronTaskRunsForTests();
    let settle = () => {};
    const core = new Promise<void>((resolve) => {
      settle = resolve;
    });
    trackActiveCronTaskRunSettlement(core);
    startActiveCronTaskRunSettlementGrace();

    expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
    settle();
    await core;
    await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
  });
});

describe("waitForActiveCronTaskRuns abort", () => {
  it("resolves early when the signal is already aborted", async () => {
    resetActiveCronTaskRunsForTests();
    trackActiveCronTaskRunSettlement(new Promise<never>(() => {}));

    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    const result = await waitForActiveCronTaskRuns(10_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.drained).toBe(false);
    expect(result.active).toBeGreaterThan(0);
    resetActiveCronTaskRunsForTests();
  });

  it("wakes the poll when the signal is aborted mid-wait", async () => {
    vi.useFakeTimers();
    try {
      resetActiveCronTaskRunsForTests();
      trackActiveCronTaskRunSettlement(new Promise<never>(() => {}));

      const controller = new AbortController();
      const promise = waitForActiveCronTaskRuns(10_000, controller.signal);

      await vi.advanceTimersByTimeAsync(80);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      const result = await promise;
      expect(result.drained).toBe(false);
      expect(result.active).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });

  it("honours the deadline when no signal is provided", async () => {
    vi.useFakeTimers();
    try {
      resetActiveCronTaskRunsForTests();
      trackActiveCronTaskRunSettlement(new Promise<never>(() => {}));

      const promise = waitForActiveCronTaskRuns(500);
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;
      expect(result.drained).toBe(false);
    } finally {
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });
});

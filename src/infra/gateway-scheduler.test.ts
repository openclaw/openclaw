import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

function fixture() {
  const time = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(time.clock);
  return { time, scheduler };
}

describe("Gateway timed work", () => {
  it("arms only the earliest wake and fences canceled host wakes and replaced registrations", async () => {
    const { time, scheduler } = fixture();
    const run = vi.fn();
    const retired = scheduler.schedule({ id: "approval:one", atMs: 2_000, run });
    const oldWake = time.wakes[0];
    scheduler.schedule({ id: "approval:one", atMs: 1_500, run });
    retired.cancel();
    expect(oldWake).toBeDefined();
    await oldWake?.run();
    expect(scheduler.nextWakeAtMs).toBe(1_500);
    expect(time.armedAtMs).toBe(1_500);
    await time.advanceTo(1_500);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).toBeNull();
    await scheduler.stop();
  });

  it("coalesces sleep and forward jumps into one pass while retaining absolute deadlines", async () => {
    const { time, scheduler } = fixture();
    const periodic = vi.fn();
    const deadline = vi.fn();
    scheduler.schedule({ id: "approval", atMs: 5_000, run: deadline });
    scheduler.schedule({ id: "health", atMs: 2_000, everyMs: 1_000, run: periodic });
    await time.advanceTo(301_000);
    expect(periodic).toHaveBeenCalledTimes(1);
    expect(deadline).toHaveBeenCalledTimes(1);
    expect(periodic).toHaveBeenCalledBefore(deadline);
    expect(scheduler.nextWakeAtMs).toBe(302_000);
    await time.advanceTo(302_000);
    expect(periodic).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it.each([
    { mode: undefined, nextWakeAtMs: 3_000 },
    { mode: "replace" as const, nextWakeAtMs: 3_000 },
    { mode: "earliest" as const, nextWakeAtMs: 2_000 },
  ])("reschedules a pending deadline in $mode mode", async ({ mode, nextWakeAtMs }) => {
    const { time, scheduler } = fixture();
    const retiredRun = vi.fn();
    const run = vi.fn();
    const retired = scheduler.schedule({ id: "queue", atMs: 2_000, run: retiredRun });
    scheduler.schedule({ id: "queue", atMs: 3_000, mode, run });
    retired.cancel();
    expect(scheduler.nextWakeAtMs).toBe(nextWakeAtMs);
    await time.advanceTo(nextWakeAtMs);
    expect(run).toHaveBeenCalledOnce();
    expect(retiredRun).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBeNull();
    await scheduler.stop();
  });

  it("brings a pending deadline forward in earliest mode", async () => {
    const { time, scheduler } = fixture();
    const run = vi.fn();
    scheduler.schedule({ id: "queue", atMs: 10_000, run });
    scheduler.schedule({ id: "queue", atMs: 5_000, mode: "earliest", run });
    expect(scheduler.nextWakeAtMs).toBe(5_000);
    await time.advanceTo(5_000);
    expect(run).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it.each([{ delayMs: 2_000 }, { atMs: 6_500 }])(
    "does not postpone elapsed eligibility after a backward wall-clock correction: %j",
    async (deadline) => {
      const { time, scheduler } = fixture();
      const run = vi.fn();
      time.setTime(9_000);
      scheduler.schedule({ id: "queue", delayMs: 1_000, mode: "earliest", run });
      expect(time.armedAtMs).toBe(10_000);
      time.setTime(4_000);
      await time.advanceBy(500);
      scheduler.schedule({ id: "queue", ...deadline, mode: "earliest", run });
      expect(scheduler.nextWakeAtMs).toBe(5_000);
      await time.advanceTo(5_000);
      expect(run).toHaveBeenCalledOnce();
      expect(scheduler.nextWakeAtMs).toBeNull();
      await scheduler.stop();
    },
  );

  it("keeps the earlier wall deadline as well as the elapsed deadline", async () => {
    const { time, scheduler } = fixture();
    const run = vi.fn();
    time.setTime(9_000);
    scheduler.schedule({ id: "queue", delayMs: 1_000, mode: "earliest", run });
    time.setTime(4_000);
    await time.advanceBy(500);
    scheduler.schedule({ id: "queue", delayMs: 2_000, mode: "earliest", run });
    time.setTime(6_499);
    scheduler.schedule({ id: "other", atMs: 6_499, run: () => {} });
    await time.wake();
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBe(6_500);
    await time.advanceBy(1);
    expect(run).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it("retains an already elapsed wake when another due job refreshes its deadline", async () => {
    const { time, scheduler } = fixture();
    const run = vi.fn();
    time.setTime(9_000);
    scheduler.schedule({
      id: "refresh",
      delayMs: 1_000,
      run: () => {
        scheduler.schedule({ id: "queue", delayMs: 2_000, mode: "earliest", run });
      },
    });
    scheduler.schedule({ id: "queue", delayMs: 1_000, mode: "earliest", run });
    time.setTime(4_000);
    await time.wake();
    expect(scheduler.nextWakeAtMs).toBe(4_000);
    await time.wake();
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.nextWakeAtMs).toBeNull();
    await scheduler.stop();
  });

  it("allows a later earliest deadline after cancel, stop, or completion", async () => {
    const { time, scheduler } = fixture();
    const run = vi.fn();
    const cancelled = scheduler.schedule({ id: "queue", delayMs: 500, mode: "earliest", run });
    cancelled.cancel();
    const stopped = scheduler.schedule({ id: "queue", delayMs: 1_000, mode: "earliest", run });
    expect(scheduler.nextWakeAtMs).toBe(2_000);
    await stopped.stop();
    scheduler.schedule({
      id: "queue",
      delayMs: 2_000,
      mode: "earliest",
      run: () => {
        run();
        scheduler.schedule({ id: "queue", delayMs: 1_000, mode: "earliest", run });
      },
    });
    expect(scheduler.nextWakeAtMs).toBe(3_000);
    await time.advanceTo(3_000);
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.nextWakeAtMs).toBe(4_000);
    await time.advanceTo(4_000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("keeps cadence on a backward host wake without expiring durable deadlines early", async () => {
    const { time, scheduler } = fixture();
    const cadence = vi.fn();
    const deadline = vi.fn();
    scheduler.schedule({ id: "sample", atMs: 2_000, everyMs: 1_000, run: cadence });
    scheduler.schedule({ id: "lease-expiry", atMs: 2_000, run: deadline });
    time.setTime(1_500);
    await time.wake();
    expect(cadence).toHaveBeenCalledTimes(1);
    expect(deadline).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBe(2_000);
    await time.advanceTo(2_000);
    expect(deadline).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("preserves elapsed cadence when new work is registered after a clock rollback", async () => {
    const { time, scheduler } = fixture();
    const run = vi.fn();
    scheduler.schedule({ id: "health", delayMs: 1_000, everyMs: 1_000, run });
    await time.advanceBy(500);
    time.setTime(0);
    scheduler.schedule({ id: "new-deadline", atMs: 0, run: () => {} });
    await time.wake();
    expect(scheduler.nextWakeAtMs).toBe(500);
    await time.advanceBy(500);
    expect(run).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it("keeps unrelated jobs progressing and joins descendants before shutdown completes", async () => {
    const { time, scheduler } = fixture();
    const child = createDeferredCore();
    const run = vi.fn(() => {
      void trackAsyncWork(() => child.promise);
    });
    scheduler.schedule({ id: "cleanup", atMs: 1_000, everyMs: 100, run });
    const firstWake = time.wake();
    const other = vi.fn();
    scheduler.schedule({ id: "other", atMs: 1_100, run: other });
    await time.advanceTo(1_100);
    expect(other).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    const stopped = vi.fn();
    const stop = scheduler.stop().then(stopped);
    expect(time.armedAtMs).toBeNull();
    expect(stopped).not.toHaveBeenCalled();
    scheduler.schedule({ id: "late", atMs: 1_100, run: other });
    child.resolve();
    await Promise.all([stop, firstWake]);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("preserves registration context and permits a deadline owner to rearm while running", async () => {
    const { time, scheduler } = fixture();
    const context = new AsyncLocalStorage<string>();
    const gate = createDeferredCore();
    const seen: Array<string | undefined> = [];
    context.run("cron-owner", () =>
      scheduler.schedule({
        id: "cron",
        atMs: 1_000,
        run: async () => {
          seen.push(context.getStore());
          scheduler.schedule({
            id: "cron",
            atMs: 1_100,
            run: () => {
              seen.push(context.getStore());
            },
          });
          await gate.promise;
          throw new Error("run failed");
        },
      }),
    );
    const initial = time.wake();
    await time.advanceTo(1_100);
    expect(seen).toEqual(["cron-owner", "cron-owner"]);
    gate.resolve();
    await initial;
    expect(scheduler.nextWakeAtMs).toBeNull();
    await scheduler.stop();
  });

  it("retains a distant deadline across the host timer delay ceiling", async () => {
    const { time, scheduler } = fixture();
    const run = vi.fn();
    scheduler.schedule({ id: "future", atMs: 4_000_000_000, run });
    await time.advanceTo(1_000 + 2_147_483_647);
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBe(4_000_000_000);
    await time.advanceTo(4_000_000_000);
    expect(run).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});

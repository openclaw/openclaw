import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

const schedulerLog = vi.hoisted(() => ({ debug: vi.fn(), trace: vi.fn(), error: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => schedulerLog,
}));

function fixture() {
  const time = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(time.clock);
  return { time, scheduler };
}

describe("Gateway timed work", () => {
  it("preserves equal-deadline dispatch order when replacing a waiting registration", async () => {
    const { time, scheduler } = fixture();
    const seen: string[] = [];
    const record = (value: string) => () => {
      seen.push(value);
    };
    scheduler.schedule({ id: "first", delayMs: 100, run: record("retired") });
    scheduler.schedule({ id: "second", delayMs: 100, run: record("second") });
    scheduler.schedule({ id: "first", delayMs: 100, run: record("replacement") });
    await time.advanceBy(100);
    expect(seen).toEqual(["replacement", "second"]);
    await scheduler.stop();
  });

  it("closes one scope without canceling a sibling's replacement registration", async () => {
    const { time, scheduler } = fixture();
    const retired = scheduler.scope();
    const active = scheduler.scope();
    const run = vi.fn();
    retired.schedule({ id: "maintenance", delayMs: 100, run });
    active.schedule({ id: "maintenance", delayMs: 200, run });
    await retired.stop();
    retired.schedule({ id: "maintenance", delayMs: 0, run: () => run("retired") });
    expect(retired.signal.aborted).toBe(true);
    expect(active.signal.aborted).toBe(false);
    expect(scheduler.nextWakeAtMs).toBe(1_200);
    await time.advanceTo(1_200);
    expect(run).toHaveBeenCalledExactlyOnceWith();
    await scheduler.stop();
    expect(active.signal.aborted).toBe(true);
  });

  it("joins replaced callbacks and tracked descendants after one-shot dispatch", async () => {
    const { time, scheduler } = fixture();
    const scope = scheduler.scope();
    const first = createDeferredCore();
    const second = createDeferredCore();
    const run = vi.fn();
    scope.schedule({
      id: "maintenance",
      delayMs: 0,
      everyMs: 100,
      run: () => {
        void trackAsyncWork(() => first.promise);
      },
    });
    const firstWake = time.wake();
    scope.schedule({
      id: "maintenance",
      delayMs: 0,
      run: async () => {
        await second.promise;
        scope.schedule({ id: "late", delayMs: 0, run });
      },
    });
    const secondWake = time.wake();
    scope.schedule({ id: "waiting", delayMs: 100, run });
    const stopped = vi.fn();
    const stop = scope.stop().then(stopped);
    expect(scope.signal.aborted).toBe(true);
    expect(scheduler.nextWakeAtMs).toBeNull();
    second.resolve();
    await secondWake;
    expect(stopped).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBeNull();
    first.resolve();
    await Promise.all([firstWake, stop, scope.stop()]);
    expect(stopped).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("fences scoped jobs when a due sibling closes their owner", async () => {
    const { time, scheduler } = fixture();
    const scope = scheduler.scope();
    const run = vi.fn();
    scheduler.schedule({ id: "retire-owner", delayMs: 0, run: scope.beginClose });
    scope.schedule({ id: "retired", delayMs: 0, run });
    await time.wake();
    expect(run).not.toHaveBeenCalled();
    await scope.stop();
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
    { mode: undefined, atMs: 3_000, nextWakeAtMs: 3_000 },
    { mode: "earliest" as const, atMs: 3_000, nextWakeAtMs: 2_000 },
    { mode: "earliest" as const, atMs: 1_500, nextWakeAtMs: 1_500 },
  ])(
    "reschedules a pending deadline to $atMs in $mode mode",
    async ({ mode, atMs, nextWakeAtMs }) => {
      const { time, scheduler } = fixture();
      const retiredRun = vi.fn();
      const run = vi.fn();
      const retired = scheduler.schedule({ id: "queue", atMs: 2_000, run: retiredRun });
      const oldWake = time.wakes[0];
      scheduler.schedule({ id: "queue", atMs, mode, run });
      retired.cancel();
      expect(oldWake).toBeDefined();
      await oldWake?.run();
      expect(scheduler.nextWakeAtMs).toBe(nextWakeAtMs);
      expect(time.armedAtMs).toBe(nextWakeAtMs);
      await time.advanceTo(nextWakeAtMs);
      expect(run).toHaveBeenCalledOnce();
      expect(retiredRun).not.toHaveBeenCalled();
      expect(scheduler.nextWakeAtMs).toBeNull();
      await scheduler.stop();
    },
  );

  it.each([
    { deadline: { delayMs: 2_000 }, clock: "elapsed" },
    { deadline: { atMs: 6_500 }, clock: "elapsed" },
    { deadline: { delayMs: 2_000 }, clock: "wall" },
  ])(
    "retains $clock eligibility after a backward wall-clock correction: $deadline",
    async ({ deadline, clock }) => {
      const { time, scheduler } = fixture();
      const run = vi.fn();
      time.setTime(9_000);
      scheduler.schedule({ id: "queue", delayMs: 1_000, mode: "earliest", run });
      expect(time.armedAtMs).toBe(10_000);
      time.setTime(4_000);
      await time.advanceBy(500);
      scheduler.schedule({ id: "queue", ...deadline, mode: "earliest", run });
      expect(scheduler.nextWakeAtMs).toBe(5_000);
      if (clock === "wall") {
        time.setTime(6_499);
        scheduler.schedule({ id: "other", atMs: 6_499, run: () => {} });
        await time.wake();
        expect(run).not.toHaveBeenCalled();
        expect(scheduler.nextWakeAtMs).toBe(6_500);
        await time.advanceBy(1);
      } else {
        await time.advanceTo(5_000);
      }
      expect(run).toHaveBeenCalledOnce();
      expect(scheduler.nextWakeAtMs).toBeNull();
      await scheduler.stop();
    },
  );

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

  it("logs one-shot runs at debug and repeating cadence runs only at trace", async () => {
    const { time, scheduler } = fixture();
    schedulerLog.debug.mockClear();
    schedulerLog.trace.mockClear();
    const sample = vi.fn();
    scheduler.schedule({ id: "event-loop-health", delayMs: 20, everyMs: 20, run: sample });
    scheduler.schedule({ id: "approval", delayMs: 30, run: () => {} });
    await time.advanceBy(20);
    await time.advanceBy(20);
    await time.advanceBy(20);
    expect(sample).toHaveBeenCalledTimes(3);
    expect(schedulerLog.debug.mock.calls).toEqual([["running approval"]]);
    expect(schedulerLog.trace.mock.calls).toEqual([
      ["running event-loop-health"],
      ["running event-loop-health"],
      ["running event-loop-health"],
    ]);
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

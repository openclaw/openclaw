import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import {
  createGatewaySchedulerClock as schedulerClock,
  createTestGatewayScheduler as createScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as matcher from "./cron-stream-matcher.js";
import {
  createCronStreamMatchingJob as matchingJob,
  createCronStreamWatcherFixture as createFixture,
  exitResult,
  job,
  settle,
} from "./cron-stream-watchers.test-helpers.js";

const batchArgs = (text: string) => [
  expect.any(Object),
  text,
  expect.any(String),
  expect.any(String),
];
const coalescedArgs = [
  "stream-job",
  expect.objectContaining({ streamCoalescedBatches: 1 }),
  expect.any(String),
  expect.any(String),
];
const blockedFire = (gate: Promise<void>) =>
  vi.fn(async () => {
    await gate;
    return "fired" as const;
  });
function pausedOutput(coalesced: number, once = false) {
  const payload = createDeferred();
  const counter = createDeferred();
  const entered = createDeferred();
  const fireBatch = blockedFire(payload.promise);
  if (once) {
    fireBatch.mockResolvedValue("fired").mockImplementationOnce(async () => {
      await payload.promise;
      return "fired";
    });
  }
  const fixture = createFixture({
    minIntervalMs: 1,
    retryBackoffMs: once ? [1] : undefined,
    fireBatch,
    updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
      if (patch.streamCoalescedBatches === coalesced) {
        entered.resolve();
        await counter.promise;
      }
    }),
  });
  return { ...fixture, payload, counter, entered: entered.promise };
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}
async function queueTwoBatches(fake: ReturnType<typeof createFixture>["fake"]) {
  fake.inputs[0]?.onStdout?.("first\n");
  await vi.advanceTimersByTimeAsync(50);
  fake.inputs[0]?.onStdout?.("second\n");
  await advance(50);
}

describe("cron stream output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("coalesces late quiet and busy-retry wakes and resumes after an owner stop", async () => {
    const clock = schedulerClock(1_000);
    const scheduler = createScheduler(clock.clock);
    const fireBatch = vi.fn().mockResolvedValueOnce("busy").mockResolvedValue("fired");
    const { fake, watchers } = createFixture({
      scheduler,
      minIntervalMs: 100,
      fireBatch,
    });
    try {
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("first\n");
      await settle();
      clock.setTime(5_000);
      await clock.wake();
      await settle();
      expect(fireBatch).toHaveBeenCalledExactlyOnceWith(...batchArgs("first"));

      clock.setTime(10_000);
      await clock.wake();
      await settle();
      expect(fireBatch).toHaveBeenCalledTimes(2);
      expect(fireBatch).toHaveBeenLastCalledWith(...batchArgs("first"));
      await watchers.stop("stream-job", "disabled");
      expect(scheduler.nextWakeAtMs).toBeNull();

      await watchers.start(job());
      fake.inputs[1]?.onStdout?.("resumed\n");
      await settle();
      await clock.advanceBy(100);
      expect(fireBatch).toHaveBeenCalledTimes(3);
      expect(fireBatch).toHaveBeenLastCalledWith(...batchArgs("resumed"));
    } finally {
      await watchers.stopAll("shutdown");
      await scheduler.stop();
    }
  });

  it("restarts the quiet window when a match overtakes a queued close", async () => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const matching = createDeferred<boolean>();
    vi.spyOn(matcher, "matchCronStreamLines")
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        entered.resolve();
        return await matching.promise;
      });
    const { fake, fireBatch, watchers } = createFixture({ minIntervalMs: 1 });
    try {
      await watchers.start(matchingJob("^keep"));
      fake.inputs[0]?.onStdout?.("keep first\n");
      await settle();
      fake.inputs[0]?.onStdout?.("keep second\n");
      await entered.promise;

      await vi.advanceTimersByTimeAsync(50);
      matching.resolve(true);
      await settle();
      expect(fireBatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(49);
      expect(fireBatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fireBatch).toHaveBeenCalledExactlyOnceWith(...batchArgs("keep first\nkeep second"));
      expect(watchers.inspect("stream-job")).toMatchObject({
        droppedBatches: 0,
        coalescedBatches: 0,
      });
    } finally {
      matching.resolve(false);
      await watchers.stopAll("shutdown");
    }
  });

  it.each(["open", "in-flight"] as const)(
    "freezes counters after stopping an %s batch",
    async (phase) => {
      vi.useFakeTimers();
      const payload = createDeferred();
      const { fake, updateState, fireBatch, watchers } = createFixture({
        minIntervalMs: 1,
        ...(phase === "in-flight" ? { fireBatch: blockedFire(payload.promise) } : {}),
      });
      await watchers.start(job());
      const lateOutput = fake.inputs[0]?.onStdout;
      lateOutput?.(phase === "open" ? "open batch\n" : "in flight\n");
      await settle();
      if (phase === "in-flight") {
        await vi.advanceTimersByTimeAsync(50);
      }
      const stopping = watchers.stop("stream-job", "disabled");
      if (phase === "in-flight") {
        await settle();
        await vi.advanceTimersByTimeAsync(10_000);
      }
      await stopping;
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
        ...(phase === "open"
          ? { processAlive: false, restartTimerPending: false, coalescedBatches: 0 }
          : {}),
      });
      const counterWrites = () =>
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined);
      const before = counterWrites().length;
      if (phase === "open") {
        expect(fireBatch).not.toHaveBeenCalled();
        expect(before).toBe(1);
        lateOutput?.("late batch\n");
        await vi.runAllTimersAsync();
      } else {
        payload.resolve();
      }
      await settle();
      expect(counterWrites()).toHaveLength(before);
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(1);
    },
  );
  it("ignores obsolete process output during backoff and after replacement", async () => {
    vi.useFakeTimers();
    const { fake, updateState, watchers } = createFixture({
      minIntervalMs: 1,
      retryBackoffMs: [10],
    });
    await watchers.start(job());
    const obsoleteOutput = fake.inputs[0]?.onStdout;
    fake.exits[0]?.(exitResult());
    await settle();
    expect(watchers.inspect("stream-job")?.state).toBe("backoff");

    obsoleteOutput?.("late during backoff\n");
    await settle();
    expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);

    await advance(10);
    expect(fake.spawn).toHaveBeenCalledTimes(2);

    obsoleteOutput?.("late after replacement\n");
    await settle();

    expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);
    expect(
      updateState.mock.calls.some(([, patch]) => patch.streamDroppedBatches !== undefined),
    ).toBe(false);
    await watchers.stopAll("shutdown");
  });

  it("retains a cadence-delayed batch across source restart backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { fake, fireBatch, watchers } = createFixture({
      minIntervalMs: 100,
      retryBackoffMs: [200],
    });
    await watchers.start(job());
    const initialOwner = watchers.inspect("stream-job");
    expect(initialOwner?.sourceIdentity).toBe("source:stream-job");
    fake.inputs[0]?.onStdout?.("first\n");
    await advance(50);
    fake.inputs[0]?.onStdout?.("pending\n");
    await vi.advanceTimersByTimeAsync(50);
    fake.exits[0]?.(exitResult());
    await settle();

    await vi.advanceTimersByTimeAsync(50);
    expect(fireBatch).toHaveBeenCalledTimes(1);
    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "backoff",
      droppedBatches: 0,
    });

    await advance(150);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(watchers.inspect("stream-job")).toMatchObject({
      sourceIdentity: initialOwner?.sourceIdentity,
    });
    expect(fireBatch).toHaveBeenLastCalledWith(
      expect.any(Object),
      "pending",
      expect.any(String),
      initialOwner?.sourceIdentity,
    );
    await watchers.stopAll("shutdown");
  });

  it.each(["exhaustion", "stop"] as const)("counts pending input when %s wins", async (ending) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { fake, recordFailure, fireBatch, watchers } = createFixture({ minIntervalMs: 100 });
    await watchers.start(
      ending === "exhaustion"
        ? job({ state: { lastRunAtMs: 1_000, streamConsecutiveFailures: 4 } })
        : job(),
    );
    if (ending === "stop") {
      fake.inputs[0]?.onStdout?.("first\n");
      await advance(50);
    }
    fake.inputs[0]?.onStdout?.("pending\n");
    await vi.advanceTimersByTimeAsync(50);
    if (ending === "exhaustion") {
      fake.exits[0]?.(exitResult());
      await settle();
      expect(recordFailure).toHaveBeenCalledOnce();
    } else {
      await settle();
      vi.advanceTimersByTime(50);
      await watchers.stop("stream-job", "disabled");
    }
    expect(fireBatch).toHaveBeenCalledTimes(ending === "stop" ? 1 : 0);
    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "stopped",
      droppedBatches: 1,
      ...(ending === "exhaustion" ? { consecutiveFailures: 5 } : {}),
    });
  });
  it("drains output accepted behind a slow owner write before entering backoff", async () => {
    vi.useFakeTimers();
    const { fake, watchers, fireBatch, updateState, counter, payload } = pausedOutput(1, true);
    await watchers.start(job());
    await queueTwoBatches(fake);
    expect(updateState).toHaveBeenCalledWith(...coalescedArgs);

    fake.inputs[0]?.onStdout?.("accepted-before-exit\n");
    fake.exits[0]?.(exitResult());
    counter.resolve();
    await settle();
    expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);

    payload.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(2);
    expect(fireBatch).toHaveBeenLastCalledWith(...batchArgs("second\naccepted-before-exit"));
    await watchers.stopAll("shutdown");
  });

  it("lets a stop requested during exit draining own teardown without counting failure", async () => {
    vi.useFakeTimers();
    const { fake, recordFailure, watchers, payload, counter, entered } = pausedOutput(2);
    await watchers.start(job({ state: { streamConsecutiveFailures: 4 } }));
    await queueTwoBatches(fake);

    fake.inputs[0]?.onStdout?.("accepted-before-exit\n");
    fake.exits[0]?.(exitResult());
    await entered;
    const stopping = watchers.stop("stream-job", "disabled");
    payload.resolve();
    counter.resolve();
    await settle();
    await stopping;

    expect(recordFailure).not.toHaveBeenCalled();
    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "stopped",
      consecutiveFailures: 4,
    });
  });

  it("bounds raw output while a serialized counter write is slow", async () => {
    vi.useFakeTimers();
    const { fake, watchers, updateState, counter, payload } = pausedOutput(1);
    await watchers.start(
      job({
        schedule: {
          kind: "stream",
          command: ["source"],
          batchMs: 50,
          maxBatchBytes: 1_024,
        },
      }),
    );
    fake.inputs[0]?.onStdout?.("first\n");
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    fake.inputs[0]?.onStdout?.("second\n");
    await settle();
    await advance(50);
    expect(updateState).toHaveBeenCalledWith(...coalescedArgs);

    for (let index = 0; index < 1_000; index += 1) {
      fake.inputs[0]?.onStdout?.(`${"x".repeat(100)}\n`);
    }
    expect(watchers.inspect("stream-job")).toMatchObject({
      // Raw intake is bounded at 4x the batch cap between drains.
      bufferedOutputBytes: 4_096,
      bufferedOutputSegments: 1,
    });

    counter.resolve();
    payload.resolve();
    await advance(100);
    await watchers.stopAll("shutdown");
  });
});

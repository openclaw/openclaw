import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatWakeHandler,
} from "../../infra/heartbeat-wake.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { executeJobCore } from "./timer-execution.js";

const sessionKey = "agent:main:main";
const ran = { status: "ran", durationMs: 1 } as const;

const drainEvents = () => drainSystemEventEntries(sessionKey).map((event) => event.text);
const peekEvents = () => peekSystemEventEntries(sessionKey).map((event) => event.text);
const drainAndRun = async () => {
  drainEvents();
  return ran;
};
function retryHandler(reason: string, delay: number, repeat = false) {
  const deferred = () => ({ status: "skipped" as const, reason, retryAtMs: Date.now() + delay });
  return vi
    .fn<HeartbeatWakeHandler>(repeat ? async () => deferred() : drainAndRun)
    .mockResolvedValueOnce(deferred());
}

async function advance(ms: number, handler: ReturnType<typeof retryHandler>, calls: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(handler).toHaveBeenCalledTimes(calls);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
});
afterEach(async () => {
  setHeartbeatWakeHandler(async () => ran);
  await vi.advanceTimersByTimeAsync(250);
  setHeartbeatWakeHandler(null);
  resetSystemEventsForTest();
  vi.useRealTimers();
});

function createHarness(handler: HeartbeatWakeHandler) {
  setHeartbeatWakeHandler(handler);
  const wakeQueued = createDeferred();
  const state = createCronRegressionState({
    storePath: "/unused/cron-wake-owner/jobs.json",
    enqueueSystemEvent: (text, opts) => {
      const remove = enqueueSystemEventWithReceipt(text, {
        sessionKey,
        contextKey: opts?.contextKey,
      });
      return remove ? { accepted: true, remove } : { accepted: false };
    },
    requestHeartbeatAndWait: (wake, lifecycle) => {
      const onQueued = () => {
        lifecycle?.onQueued?.();
        wakeQueued.resolve();
      };
      return requestHeartbeatAndWait(
        { ...wake, sessionKey, coalesceMs: 0 },
        { ...lifecycle, onQueued },
      );
    },
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  const run = (id = "reminder", signal?: AbortSignal) =>
    executeJobCore(
      state,
      makeCronJob({
        id,
        name: id,
        schedule: { kind: "at", at: new Date(Date.now()).toISOString() },
        payload: { kind: "systemEvent", text: id },
        sessionTarget: "main",
        wakeMode: "now",
      }),
      signal,
    );
  return { state, run, wakeQueued };
}

it("coalesces two main jobs and settles both only after their shared turn", async () => {
  const release = createDeferred();
  const observed: string[][] = [];
  const handler = vi.fn(async () => {
    observed.push(drainEvents());
    await release.promise;
    return ran;
  });
  const { run } = createHarness(handler);
  const pending = Promise.all([run("first"), run("second")]);
  const settled = vi.fn();
  void pending.then(settled);
  try {
    await advance(2 * 60_000 + 1, handler, 1);
    expect(observed).toEqual([["first", "second"]]);
    expect(settled).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await expect(pending).resolves.toEqual([
    { status: "ok", summary: "first" },
    { status: "ok", summary: "second" },
  ]);
});

it.each([false, true])("preserves the queue deadline, repeated retries=%s", async (repeats) => {
  const handler = retryHandler("requests-in-flight", 60_000, repeats);
  const { run } = createHarness(handler);
  const pending = run();
  const settled = vi.fn();
  void pending.then(settled);
  await advance(repeats ? 119_999 : 59_999, handler, repeats ? 2 : 1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ status: "ok" });
  expect(handler).toHaveBeenCalledTimes(repeats ? 3 : 2);
  if (repeats) {
    handler.mockImplementation(drainAndRun);
    await advance(59_999, handler, 3);
    await advance(1, handler, 4);
    expect(peekSystemEventEntries(sessionKey)).toHaveLength(0);
  }
});

it.each([{ reason: "requests-in-flight", retryDelay: 180_000 }])(
  "detaches the cron waiter while preserving $reason work and its deadline",
  async ({ reason, retryDelay }) => {
    const handler = retryHandler(reason, retryDelay);
    const { state, run } = createHarness(handler);
    const pending = run();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ status: "ok", summary: "reminder" });
    expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
    expect(handler.mock.calls[0]?.[0].heartbeat).toEqual({ target: "last" });
    expect(peekEvents()).toEqual(["reminder"]);
    await advance(retryDelay - 1, handler, 1);
    await advance(1, handler, 2);
    expect(peekSystemEventEntries(sessionKey)).toHaveLength(0);
  },
);

it.each([false, true])("removes only the cancelled job's event, retrying=%s", async (retrying) => {
  const observed: string[] = [];
  let calls = 0;
  const { run, wakeQueued } = createHarness(async () => {
    if (retrying && ++calls === 1) {
      return { status: "skipped", reason: "requests-in-flight" };
    }
    observed.push(...drainEvents());
    return ran;
  });
  enqueueSystemEventWithReceipt("unrelated", { sessionKey, contextKey: "other" });
  const controller = new AbortController();
  const pending = run("cancelled", controller.signal);
  await wakeQueued.promise;
  if (retrying) {
    await vi.advanceTimersByTimeAsync(0);
  }
  controller.abort();
  await expect(pending).resolves.toMatchObject({ status: "error" });
  expect(peekEvents()).toEqual(["unrelated"]);
  await vi.advanceTimersByTimeAsync(retrying ? 1_000 : 0);
  expect(observed).toEqual(["unrelated"]);
});

it("removes only the failed job's event after terminal wake failure", async () => {
  const { run } = createHarness(async () => ({ status: "failed", reason: "runner refused" }));
  enqueueSystemEventWithReceipt("unrelated", { sessionKey, contextKey: "other" });
  const pending = run();
  await vi.advanceTimersByTimeAsync(0);
  await expect(pending).resolves.toMatchObject({ status: "error", error: "runner refused" });
  expect(peekEvents()).toEqual(["unrelated"]);
});

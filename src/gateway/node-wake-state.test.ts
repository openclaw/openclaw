import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { NodeWakeAttempt } from "./node-wake-state-store.js";
import * as wakeState from "./node-wake-state.js";
import * as testState from "./node-wake-state.test-support.js";

const sentWake = { available: true, throttled: false, path: "sent", durationMs: 1 } as const;

function wake(nodeId: string, force = false) {
  return wakeState.runNodeWakeAttempt({
    nodeId,
    force,
    throttleMs: 1_000,
    attempt: async (markAttempted) => {
      markAttempted();
      return sentWake;
    },
  });
}

beforeEach(testState.resetNodeWakeStateForTest);
afterEach(() => vi.restoreAllMocks());

it("isolates generations and invalidates every generation for a removed node", () => {
  const first = wakeState.captureNodeWakeLifecycle("node-1", "generation-1");
  const second = wakeState.captureNodeWakeLifecycle("node-1", "generation-2");

  expect(wakeState.isNodeWakeLifecycleCurrent("node-1", first, "generation-1")).toBe(true);
  expect(wakeState.isNodeWakeLifecycleCurrent("node-1", first, "generation-2")).toBe(false);
  expect(wakeState.isNodeWakeLifecycleCurrent("node-1", second, "generation-2")).toBe(true);

  wakeState.invalidateNodeWakeState("node-1");

  expect([first.aborted, second.aborted]).toEqual([true, true]);
  expect(
    ["generation-1", "generation-2"].map((g) => testState.getNodeWakeStateSnapshot("node-1", g)),
  ).toEqual([undefined, undefined]);
});

it.each([false, true])(
  "releases idle state but retains an active lifecycle (active=%s)",
  async (active) => {
    const lifecycle = wakeState.captureNodeWakeLifecycle("node-1");
    if (active) {
      await wake("node-1", true);
      wakeState.clearNodeWakeState("node-1");
    } else {
      wakeState.releaseNodeWakeLifecycle("node-1", lifecycle);
    }
    expect(lifecycle.aborted).toBe(!active);
    const snapshot = testState.getNodeWakeStateSnapshot("node-1");
    expect(active ? snapshot?.lastWakeAtMs : snapshot).toBeUndefined();
    if (active) {
      wakeState.releaseNodeWakeLifecycle("node-1", lifecycle);
    }
  },
);
it.each([-3_600_000, 3_600_000])(
  "keeps wake and nudge throttle intervals across a %i ms wall-clock change",
  async (clockChange) => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(10_000_000);
    const nudge = () =>
      wakeState.runNodeWakeNudgeAttempt({
        nodeId: "clock-node",
        throttleMs: 1_000,
        throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
        attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 0 }),
      });

    expect((await wake("clock-node")).path).toBe("sent");
    expect((await nudge()).reason).toBe("sent");
    wallClock.mockReturnValue(10_000_000 + clockChange);
    elapsed = 999;
    expect(await wake("clock-node")).toEqual({
      available: true,
      throttled: true,
      path: "throttled",
      durationMs: 0,
    });
    expect((await nudge()).reason).toBe("throttled");
    elapsed = 1_000;
    expect((await wake("clock-node")).path).toBe("sent");
    expect((await nudge()).reason).toBe("sent");
  },
);

it("deduplicates concurrent wake attempts for one generation", async () => {
  const pending = createDeferred<NodeWakeAttempt>();
  const attempt = vi.fn(() => pending.promise);
  const params = {
    nodeId: "node-1",
    pairingGeneration: "generation-1",
    force: false,
    throttleMs: 1_000,
    attempt,
  };

  const first = wakeState.runNodeWakeAttempt(params);
  const second = wakeState.runNodeWakeAttempt(params);
  expect(attempt).toHaveBeenCalledOnce();
  pending.resolve(sentWake);

  await expect(first).resolves.toEqual(sentWake);
  await expect(second).resolves.toEqual(sentWake);
});

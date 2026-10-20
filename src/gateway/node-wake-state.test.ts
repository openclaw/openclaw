import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { NodeWakeAttempt } from "./node-wake-state-store.js";
import {
  captureNodeWakeLifecycle,
  clearNodeWakeState,
  invalidateNodeWakeState,
  isNodeWakeLifecycleCurrent,
  releaseNodeWakeLifecycle,
  runNodeWakeAttempt,
  runNodeWakeNudgeAttempt,
} from "./node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
} from "./node-wake-state.test-support.js";

const sentWake: NodeWakeAttempt = {
  available: true,
  throttled: false,
  path: "sent",
  durationMs: 1,
};

function wake(nodeId: string, force = false) {
  return runNodeWakeAttempt({
    nodeId,
    force,
    throttleMs: 1_000,
    attempt: async (markAttempted) => {
      markAttempted();
      return sentWake;
    },
  });
}

beforeEach(resetNodeWakeStateForTest);
afterEach(() => vi.restoreAllMocks());

describe("node wake lifecycle ownership", () => {
  it("isolates generations and invalidates every generation for a removed node", () => {
    const generationOne = captureNodeWakeLifecycle("node-1", "generation-1");
    const generationTwo = captureNodeWakeLifecycle("node-1", "generation-2");

    expect(isNodeWakeLifecycleCurrent("node-1", generationOne, "generation-1")).toBe(true);
    expect(isNodeWakeLifecycleCurrent("node-1", generationOne, "generation-2")).toBe(false);
    expect(isNodeWakeLifecycleCurrent("node-1", generationTwo, "generation-2")).toBe(true);

    invalidateNodeWakeState("node-1");

    expect([generationOne.aborted, generationTwo.aborted]).toEqual([true, true]);
    expect(
      ["generation-1", "generation-2"].map((g) => getNodeWakeStateSnapshot("node-1", g)),
    ).toEqual([undefined, undefined]);
  });

  it.each([false, true])(
    "releases idle state but retains an active lifecycle (active=%s)",
    async (active) => {
      const lifecycle = captureNodeWakeLifecycle("node-1");
      if (active) {
        await wake("node-1", true);
        clearNodeWakeState("node-1");
      } else {
        releaseNodeWakeLifecycle("node-1", lifecycle);
      }
      expect(lifecycle.aborted).toBe(!active);
      const snapshot = getNodeWakeStateSnapshot("node-1");
      expect(active ? snapshot?.lastWakeAtMs : snapshot).toBeUndefined();
      if (active) {
        releaseNodeWakeLifecycle("node-1", lifecycle);
      }
    },
  );
});

describe("node wake coordination", () => {
  it.each([-3_600_000, 3_600_000])(
    "keeps wake and nudge throttle intervals across a %i ms wall-clock change",
    async (clockChange) => {
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(10_000_000);
      const nudge = () =>
        runNodeWakeNudgeAttempt({
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

    const first = runNodeWakeAttempt(params);
    const second = runNodeWakeAttempt(params);
    expect(attempt).toHaveBeenCalledOnce();
    pending.resolve(sentWake);

    await expect(first).resolves.toEqual(sentWake);
    await expect(second).resolves.toEqual(sentWake);
  });
});

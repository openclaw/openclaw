import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

describe("GatewayNodeLifecycleDispatchTracker", () => {
  it("drains every admitted node progress and terminal result", async () => {
    const tracker = new GatewayNodeLifecycleDispatchTracker();
    const events: string[] = [];
    const { promise: progressGate, resolve: releaseProgress } = createDeferred();

    const progress = tracker.dispatch("node.invoke.progress", async () => {
      events.push("progress-start");
      await progressGate;
      events.push("progress-end");
    });
    const result = tracker.dispatch("node.invoke.result", async () => {
      events.push("result");
    });
    const drained = tracker.drain(1_000);

    await vi.waitFor(() => expect(events).toEqual(["progress-start", "result"]));
    releaseProgress?.();

    await expect(Promise.all([progress, result])).resolves.toEqual([undefined, undefined]);
    await expect(drained).resolves.toBe(true);
    expect(events).toEqual(["progress-start", "result", "progress-end"]);
  });

  it("does not queue unrelated methods and bounds a stuck lifecycle drain", async () => {
    const tracker = new GatewayNodeLifecycleDispatchTracker();
    const { promise: resultGate, resolve: releaseResult } = createDeferred();
    const result = tracker.dispatch("node.invoke.result", async () => {
      await resultGate;
    });

    await expect(tracker.dispatch("node.event", async () => undefined)).resolves.toBeUndefined();
    expect(tracker.hasActive()).toBe(true);
    await expect(tracker.drain(1)).resolves.toBe(false);

    releaseResult?.();
    await expect(result).resolves.toBeUndefined();
    expect(tracker.hasActive()).toBe(false);
    await expect(tracker.drain(1)).resolves.toBe(true);
  });

  it.each([300_000, -300_000])(
    "keeps the drain budget on the monotonic clock across a %i ms wall-clock jump",
    async (wallClockStepMs) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const perfSpy = vi.spyOn(performance, "now");
      const dateSpy = vi.spyOn(Date, "now");
      let monotonicMs = 0;
      let wallMs = 0;
      perfSpy.mockImplementation(() => monotonicMs);
      dateSpy.mockImplementation(() => wallMs);
      try {
        const tracker = new GatewayNodeLifecycleDispatchTracker();
        const { promise: firstGate, resolve: releaseFirst } = createDeferred();
        const { promise: heldGate } = createDeferred();
        void tracker.dispatch("node.invoke.progress", async () => {
          await firstGate;
          void tracker.dispatch("node.invoke.result", async () => {
            await heldGate;
          });
        });

        const drained = tracker.drain(5_000);
        await vi.advanceTimersByTimeAsync(0);

        releaseFirst();
        wallMs = wallClockStepMs;
        monotonicMs += 1_000;
        await vi.advanceTimersByTimeAsync(1_000);

        let settled = false;
        void drained.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        monotonicMs += 4_000;
        await vi.advanceTimersByTimeAsync(4_000);
        expect(settled).toBe(true);
        await expect(drained).resolves.toBe(false);
        expect(tracker.hasActive()).toBe(true);
      } finally {
        dateSpy.mockRestore();
        perfSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});

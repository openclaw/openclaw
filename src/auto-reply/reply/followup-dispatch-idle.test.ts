import { describe, expect, it, vi } from "vitest";
import { runAfterDispatchIdle, runAndWaitForDispatchIdle } from "./followup-dispatch-idle.js";

describe("followup dispatch idle helpers", () => {
  it("waits for dispatch idle before starting followup work", async () => {
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const waitForDispatchIdle = vi.fn(async () => {
      await dispatchGate;
    });

    let started = false;
    const runPromise = (async () => {
      await runAfterDispatchIdle(waitForDispatchIdle);
      started = true;
    })();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waitForDispatchIdle).toHaveBeenCalledTimes(1);
    expect(started).toBe(false);

    releaseDispatch();
    await runPromise;
    expect(started).toBe(true);
  });

  it("waits for dispatch idle again after queuing followup delivery", async () => {
    let releaseDispatch!: () => void;
    const pendingDispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const waitForDispatchIdle = vi.fn(async () => {
      await pendingDispatch;
    });
    const run = vi.fn(async () => {});

    let settled = false;
    const runPromise = runAndWaitForDispatchIdle(run, waitForDispatchIdle).then(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledTimes(1);
    expect(waitForDispatchIdle).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseDispatch();
    await runPromise;
    expect(settled).toBe(true);
  });
});

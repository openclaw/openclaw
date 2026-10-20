import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runMeetingBrowserAct } from "./browser-act-lock.js";

function run<T>(targetId: string, operation: () => Promise<T>, timeoutMs = 10_000) {
  return runMeetingBrowserAct({ targetId, operation, deadline: performance.now() + timeoutMs });
}

describe("meeting browser act lock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serializes async evaluations for one browser target", async () => {
    let active = 0;
    let maxActive = 0;
    const firstGate = createDeferred();
    const events: string[] = [];
    const entered = createDeferred();
    const evaluate = (name: string, gate?: Promise<void>) =>
      run("target-1", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start-${name}`);
        entered.resolve();
        await gate;
        events.push(`end-${name}`);
        active -= 1;
      });

    const first = evaluate("first", firstGate.promise);
    const second = evaluate("second");
    try {
      await Promise.race([entered.promise, first]);
      expect(events).toEqual(["start-first"]);
    } finally {
      firstGate.resolve();
      await Promise.all([first, second]);
    }

    expect(maxActive).toBe(1);
    expect(events).toEqual(["start-first", "end-first", "start-second", "end-second"]);
  });

  it("releases the target after a failed evaluation", async () => {
    await expect(
      run("target-failure", async () => {
        throw new Error("evaluation failed");
      }),
    ).rejects.toThrow("evaluation failed");

    await expect(run("target-failure", async () => "recovered")).resolves.toBe("recovered");
  });

  it("does not start an evaluation after its queue deadline", async () => {
    const firstGate = createDeferred();
    const first = run("target-deadline", () => firstGate.promise);
    let expiredStarted = false;
    const expired = run(
      "target-deadline",
      async () => {
        expiredStarted = true;
      },
      1_000,
    );

    const expiredResult = expect(expired).rejects.toThrow(
      "timed out waiting for browser tab control",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expiredResult;
    expect(expiredStarted).toBe(false);

    const third = run("target-deadline", async () => "recovered");
    firstGate.resolve();
    await first;
    await expect(third).resolves.toBe("recovered");
    expect(expiredStarted).toBe(false);
  });

  it("does not time out after the evaluation acquires the target", async () => {
    const gate = createDeferred();
    let settled = false;
    const running = run("target-running", () => gate.promise, 1_000).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    gate.resolve();
    await expect(running).resolves.toBeUndefined();
  });
});

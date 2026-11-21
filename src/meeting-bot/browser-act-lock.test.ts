import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runMeetingBrowserAct } from "./browser-act-lock.js";

function run<T>(targetId: string, operation: () => Promise<T>, timeoutMs = 10_000) {
  return runMeetingBrowserAct({ targetId, operation, deadline: performance.now() + timeoutMs });
}

describe("meeting browser act lock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
    const expiredOperation = vi.fn(async () => {});
    const expired = run("target-deadline", expiredOperation, 1_000);

    const expiredResult = expect(expired).rejects.toThrow(
      "timed out waiting for browser tab control",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expiredResult;
    expect(expiredOperation).not.toHaveBeenCalled();

    const third = run("target-deadline", async () => "recovered");
    firstGate.resolve();
    await first;
    await expect(third).resolves.toBe("recovered");
    expect(expiredOperation).not.toHaveBeenCalled();
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

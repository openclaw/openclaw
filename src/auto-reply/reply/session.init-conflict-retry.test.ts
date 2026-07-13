import { describe, expect, it, vi } from "vitest";
import { ReplySessionInitConflictError, runWithSessionInitConflictRetry } from "./session.js";

const SESSION_KEY = "agent:main:dashboard:test";

function conflictingAttempt(failures: number) {
  const state = { calls: 0 };
  const attempt = async () => {
    state.calls += 1;
    if (state.calls <= failures) {
      throw new ReplySessionInitConflictError(SESSION_KEY);
    }
    return "ok" as const;
  };
  return { attempt, state };
}

const instantSleep = async (_ms: number) => {};

describe("runWithSessionInitConflictRetry", () => {
  it("returns immediately when the first attempt succeeds", async () => {
    const { attempt, state } = conflictingAttempt(0);
    await expect(runWithSessionInitConflictRetry(attempt, { sleep: instantSleep })).resolves.toBe(
      "ok",
    );
    expect(state.calls).toBe(1);
  });

  it("retries conflicts and succeeds once the competing writer settles", async () => {
    const { attempt, state } = conflictingAttempt(3);
    await expect(runWithSessionInitConflictRetry(attempt, { sleep: instantSleep })).resolves.toBe(
      "ok",
    );
    expect(state.calls).toBe(4);
  });

  it("rethrows the conflict after exhausting all attempts", async () => {
    const { attempt, state } = conflictingAttempt(Number.POSITIVE_INFINITY);
    await expect(runWithSessionInitConflictRetry(attempt, { sleep: instantSleep })).rejects.toThrow(
      `reply session initialization conflicted for ${SESSION_KEY}`,
    );
    expect(state.calls).toBe(5);
  });

  it("respects a caller-provided maxAttempts", async () => {
    const { attempt, state } = conflictingAttempt(Number.POSITIVE_INFINITY);
    await expect(
      runWithSessionInitConflictRetry(attempt, { maxAttempts: 2, sleep: instantSleep }),
    ).rejects.toBeInstanceOf(ReplySessionInitConflictError);
    expect(state.calls).toBe(2);
  });

  it("does not retry non-conflict errors", async () => {
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      throw new Error("reply session initialization aborted");
    };
    await expect(runWithSessionInitConflictRetry(attempt, { sleep: instantSleep })).rejects.toThrow(
      "reply session initialization aborted",
    );
    expect(calls).toBe(1);
  });

  it("stops retrying when the abort signal fires", async () => {
    const controller = new AbortController();
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      controller.abort();
      throw new ReplySessionInitConflictError(SESSION_KEY);
    };
    await expect(
      runWithSessionInitConflictRetry(attempt, {
        signal: controller.signal,
        sleep: instantSleep,
      }),
    ).rejects.toBeInstanceOf(ReplySessionInitConflictError);
    expect(calls).toBe(1);
  });

  it("cancels an in-progress backoff without starting another attempt", async () => {
    const controller = new AbortController();
    const { attempt, state } = conflictingAttempt(Number.POSITIVE_INFINITY);
    const sleepStarted = Promise.withResolvers<void>();
    const sleep = vi.fn(
      async (_ms: number, signal?: AbortSignal) =>
        await new Promise<void>((_resolve, reject) => {
          expect(signal).toBe(controller.signal);
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted", { cause: signal.reason })),
            { once: true },
          );
          sleepStarted.resolve();
        }),
    );

    const retrying = runWithSessionInitConflictRetry(attempt, {
      signal: controller.signal,
      sleep,
    });
    await sleepStarted.promise;
    controller.abort(new Error("stop retrying"));

    await expect(retrying).rejects.toThrow("aborted");
    expect(state.calls).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("applies capped exponential backoff between attempts", async () => {
    const delays: number[] = [];
    const { attempt } = conflictingAttempt(Number.POSITIVE_INFINITY);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await runWithSessionInitConflictRetry(attempt, {
        sleep: async (ms) => {
          delays.push(ms);
        },
      }).catch(() => {});
      expect(delays).toEqual([250, 500, 1_000, 2_000]);
    } finally {
      randomSpy.mockRestore();
    }
  });
});

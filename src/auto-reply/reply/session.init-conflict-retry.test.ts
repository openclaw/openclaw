import { describe, expect, it } from "vitest";
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

  it("applies capped exponential backoff between attempts", async () => {
    const delays: number[] = [];
    const { attempt } = conflictingAttempt(Number.POSITIVE_INFINITY);
    await runWithSessionInitConflictRetry(attempt, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => {});
    expect(delays).toHaveLength(4);
    const bases = [250, 500, 1000, 2000] as const;
    for (const [index, base] of bases.entries()) {
      const delay = delays[index] ?? Number.NaN;
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThan(base + 100);
      expect(delay).toBeLessThanOrEqual(4000 + 100);
    }
  });
});

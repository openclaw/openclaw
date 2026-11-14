// Scheduler policy lives in packages/retry; core owns entropy and failure history.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRetryAttemptErrors } from "./retry-attempt-errors.js";
import { retryAsync } from "./retry.js";

const generateSecureFraction = vi.hoisted(() => vi.fn());
// mock-isolation: Fixed entropy makes retry jitter assertions deterministic.
vi.mock("./secure-random.js", () => ({ generateSecureFraction }));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  generateSecureFraction.mockReset();
});

describe("retryAsync", () => {
  it("retains every failed attempt without replacing the terminal error", async () => {
    const firstError = new Error("first");
    const terminalError = new Error("terminal");
    const fn = vi.fn().mockRejectedValueOnce(firstError).mockRejectedValueOnce(terminalError);

    const failure = await retryAsync(fn, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
    }).catch((err: unknown) => err);

    expect(failure).toBe(terminalError);
    expect(getRetryAttemptErrors(failure)).toEqual([firstError, terminalError]);
  });

  it("retries normalized parsed failures and retains terminal identity and attempt history", async () => {
    const payload = '{"__proto__":{"tag":"remote"},"code":"E_UPSTREAM","status":503}';
    const firstError = toErrorObject(JSON.parse(payload), "first attempt");
    const terminalError = toErrorObject(JSON.parse(payload), "terminal attempt");
    const fn = vi.fn().mockRejectedValueOnce(firstError).mockRejectedValueOnce(terminalError);

    const failure = await retryAsync(fn, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      shouldRetry: (error) => error instanceof Error && Reflect.get(error, "status") === 503,
    }).catch((error: unknown) => error);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(failure).toBe(terminalError);
    expect(failure).toBeInstanceOf(Error);
    expect(getRetryAttemptErrors(failure)).toEqual([firstError, terminalError]);
  });

  it("uses secure jitter when configured", async () => {
    vi.useFakeTimers();
    generateSecureFraction.mockReturnValue(1);
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const delays: number[] = [];

    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: 100,
      maxDelayMs: 200,
      jitter: 0.5,
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(delays).toEqual([150]);
    expect(generateSecureFraction).toHaveBeenCalledTimes(1);
  });
});

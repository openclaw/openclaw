import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramRetryRunner } from "./retry-policy.js";

const ZERO_DELAY_RETRY = { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };

describe("createTelegramRetryRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("strictShouldRetry", () => {
    it.each([
      {
        name: "falls back to regex matching when strictShouldRetry is disabled",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
          shouldRetry: () => false,
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("read ECONNRESET"), {
              code: "ECONNRESET",
            }),
          },
        ],
        expectedCalls: 2,
        expectedError: "ECONNRESET",
      },
      {
        name: "suppresses regex fallback when strictShouldRetry is enabled",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
          shouldRetry: () => false,
          strictShouldRetry: true,
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("read ECONNRESET"), {
              code: "ECONNRESET",
            }),
          },
        ],
        expectedCalls: 1,
        expectedError: "ECONNRESET",
      },
      {
        name: "still retries when the strict predicate returns true",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
          shouldRetry: (err: unknown) => (err as { code?: string }).code === "ECONNREFUSED",
          strictShouldRetry: true,
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          },
          { type: "resolve" as const, value: "ok" },
        ],
        expectedCalls: 2,
        expectedValue: "ok",
      },
      {
        name: "does not retry unrelated errors when neither predicate nor regex match",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("permission denied"), {
              code: "EACCES",
            }),
          },
        ],
        expectedCalls: 1,
        expectedError: "permission denied",
      },
      {
        name: "keeps retrying retriable errors until attempts are exhausted",
        runnerOptions: {
          retry: ZERO_DELAY_RETRY,
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("connection timeout"), {
              code: "ETIMEDOUT",
            }),
          },
        ],
        expectedCalls: 3,
        expectedError: "connection timeout",
      },
      {
        name: "retries grammY-style HttpError when errno lives on error.cause",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("Network request for 'sendMessage' failed!"), {
              cause: Object.assign(new Error("read ECONNRESET"), {
                code: "ECONNRESET",
              }),
            }),
          },
          { type: "resolve" as const, value: "ok" },
        ],
        expectedCalls: 2,
        expectedValue: "ok",
      },
    ])("$name", async ({ runnerOptions, fnSteps, expectedCalls, expectedValue, expectedError }) => {
      vi.useFakeTimers();
      const runner = createTelegramRetryRunner(runnerOptions);
      const fn = vi.fn();
      const allRejects = fnSteps.length > 0 && fnSteps.every((step) => step.type === "reject");
      if (allRejects) {
        fn.mockRejectedValue(fnSteps[0]?.value);
      }
      for (const [index, step] of fnSteps.entries()) {
        if (allRejects && index > 0) {
          break;
        }
        if (step.type === "reject") {
          fn.mockRejectedValueOnce(step.value);
        } else {
          fn.mockResolvedValueOnce(step.value);
        }
      }

      const promise = runner(fn, "test");
      const assertion = expectedError
        ? expect(promise).rejects.toThrow(expectedError)
        : expect(promise).resolves.toBe(expectedValue);

      await vi.runAllTimersAsync();
      await assertion;
      expect(fn).toHaveBeenCalledTimes(expectedCalls);
    });
  });

  it("honors nested retry_after hints before retrying", async () => {
    vi.useFakeTimers();

    const runner = createTelegramRetryRunner({
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1_000, jitter: 0 },
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        message: "429 Too Many Requests",
        response: { parameters: { retry_after: 1 } },
      })
      .mockResolvedValue("ok");

    const promise = runner(fn, "test");

    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

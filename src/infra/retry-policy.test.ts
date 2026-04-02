import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutboundRetryRunner, createTelegramRetryRunner } from "./retry-policy.js";

const ZERO_DELAY_RETRY = { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };

async function runRetryCase(params: {
  runnerOptions: Parameters<typeof createTelegramRetryRunner>[0];
  fnSteps: Array<{ type: "reject" | "resolve"; value: unknown }>;
  expectedCalls: number;
  expectedValue?: unknown;
  expectedError?: string;
}): Promise<void> {
  vi.useFakeTimers();
  const runner = createTelegramRetryRunner(params.runnerOptions);
  const fn = vi.fn();
  const allRejects =
    params.fnSteps.length > 0 && params.fnSteps.every((step) => step.type === "reject");
  if (allRejects) {
    fn.mockRejectedValue(params.fnSteps[0]?.value);
  }
  for (const [index, step] of params.fnSteps.entries()) {
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
  const assertion = params.expectedError
    ? expect(promise).rejects.toThrow(params.expectedError)
    : expect(promise).resolves.toBe(params.expectedValue);

  await vi.runAllTimersAsync();
  await assertion;
  expect(fn).toHaveBeenCalledTimes(params.expectedCalls);
}

describe("createTelegramRetryRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe("createOutboundRetryRunner", () => {
    it("applies configRetry before retry overrides", async () => {
      vi.useFakeTimers();

      const runner = createOutboundRetryRunner({
        defaults: { attempts: 4, minDelayMs: 25, maxDelayMs: 100, jitter: 0.5 },
        configRetry: { attempts: 2, minDelayMs: 10 },
        retry: { attempts: 3, maxDelayMs: 0, jitter: 0 },
        logLabel: "whatsapp",
        shouldRetry: () => true,
      });
      const fn = vi.fn().mockRejectedValue(new Error("timeout"));

      const promise = runner(fn, "sendText");
      const assertion = expect(promise).rejects.toThrow("timeout");
      await vi.runAllTimersAsync();

      await assertion;
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does not retry when the classifier returns false", async () => {
      vi.useFakeTimers();

      const runner = createOutboundRetryRunner({
        defaults: ZERO_DELAY_RETRY,
        retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
        logLabel: "whatsapp",
        shouldRetry: () => false,
      });
      const fn = vi.fn().mockRejectedValue(new Error("forbidden"));

      const promise = runner(fn, "sendText");
      const assertion = expect(promise).rejects.toThrow("forbidden");
      await vi.runAllTimersAsync();

      await assertion;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("honors retryAfterMs when provided", async () => {
      vi.useFakeTimers();

      const runner = createOutboundRetryRunner({
        defaults: { attempts: 2, minDelayMs: 0, maxDelayMs: 1_000, jitter: 0 },
        logLabel: "discord",
        shouldRetry: () => true,
        retryAfterMs: () => 250,
      });
      const fn = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValue("ok");

      const promise = runner(fn, "send");
      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("logs retries through the shared logger when verbose is enabled", async () => {
      vi.useFakeTimers();
      const warn = vi.fn();

      vi.resetModules();
      vi.doMock("../logging/subsystem.js", () => ({
        createSubsystemLogger: () => ({
          warn,
        }),
      }));

      const { createOutboundRetryRunner: createLoggedRunner } = await import("./retry-policy.js");

      const runner = createLoggedRunner({
        defaults: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        verbose: true,
        logLabel: "whatsapp",
        shouldRetry: () => true,
        formatRetryMessage: (info, logLabel) =>
          `${logLabel} retry ${info.attempt}/${info.maxAttempts}`,
      });
      const fn = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue("ok");

      const promise = runner(fn, "sendText");
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe("ok");
      expect(warn).toHaveBeenCalledWith("whatsapp retry 1/2");
    });

    it("can log retries even when verbose is disabled", async () => {
      vi.useFakeTimers();
      const warn = vi.fn();

      const runner = createOutboundRetryRunner({
        defaults: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        alwaysLogRetries: true,
        logLabel: "whatsapp",
        shouldRetry: () => true,
        logger: { warn },
        formatRetryMessage: (info, logLabel) =>
          `${logLabel} retry ${info.attempt}/${info.maxAttempts}`,
      });
      const fn = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue("ok");

      const promise = runner(fn, "sendText");
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe("ok");
      expect(warn).toHaveBeenCalledWith("whatsapp retry 1/2");
    });
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
        name: "retries grammY HttpError wrapping network error via .cause traversal",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("Network request for 'sendMessage' failed!"), {
              cause: new Error("ECONNRESET"),
            }),
          },
        ],
        expectedCalls: 2,
        expectedError: "Network request",
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
    ])("$name", async ({ runnerOptions, fnSteps, expectedCalls, expectedValue, expectedError }) => {
      await runRetryCase({
        runnerOptions,
        fnSteps,
        expectedCalls,
        expectedValue,
        expectedError,
      });
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

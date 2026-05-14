import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelApiRetryRunner } from "./retry-policy.js";

const ZERO_DELAY_RETRY = { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };

async function runRetryCase(params: {
  runnerOptions: Parameters<typeof createChannelApiRetryRunner>[0];
  fnSteps: Array<{ type: "reject" | "resolve"; value: unknown }>;
  expectedCalls: number;
  expectedValue?: unknown;
  expectedError?: string;
}): Promise<void> {
  vi.useFakeTimers();
  const runner = createChannelApiRetryRunner(params.runnerOptions);
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

describe("createChannelApiRetryRunner", () => {
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

  describe("perCallTimeoutMs priority resolution", () => {
    // Spec: when the runner can derive a per-call timeout from multiple
    // sources, priority order is:
    //   explicit `retry.perCallTimeoutMs`
    //   > `configRetry.perCallTimeoutMs`
    //   > `channelTimeoutSeconds * 1000`
    //   > `CHANNEL_API_RETRY_DEFAULTS.perCallTimeoutMs` (30000ms).
    // This avoids double-handling: callers that already declared a channel
    // request timeout (for example Telegram's `timeoutSeconds`) should not
    // have to repeat it as a generic retry cap.

    async function capturePerCallTimeoutMs(
      runnerOptions: Parameters<typeof createChannelApiRetryRunner>[0],
    ): Promise<number> {
      vi.useFakeTimers();
      try {
        const runner = createChannelApiRetryRunner(runnerOptions);
        // A hung call lets us read the actual per-call timeout from the
        // resulting timeout error message ("Request timeout after Nms ...").
        const fn = vi.fn<() => Promise<unknown>>(() => new Promise(() => {}));
        const promise = runner(fn, "probe");
        const settled = promise.then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error }),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await settled;
        if (result.ok) {
          throw new Error("expected timeout-or-exhaustion failure");
        }
        const message = (result.error as Error).message;
        const match = /Request timeout after (\d+)ms/.exec(message);
        if (!match) {
          throw new Error(`expected timeout error, got: ${message}`);
        }
        return Number(match[1]);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }

    it("uses channel timeoutSeconds when neither retry nor configRetry specify perCallTimeoutMs", async () => {
      const observed = await capturePerCallTimeoutMs({
        retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        channelTimeoutSeconds: 12,
      });
      expect(observed).toBe(12_000);
    });

    it("falls back to the channel default when no source provides perCallTimeoutMs", async () => {
      const observed = await capturePerCallTimeoutMs({
        retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      expect(observed).toBe(30_000);
    });

    it("prefers configRetry.perCallTimeoutMs over channelTimeoutSeconds", async () => {
      const observed = await capturePerCallTimeoutMs({
        retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        configRetry: { perCallTimeoutMs: 7_000 },
        channelTimeoutSeconds: 12,
      });
      expect(observed).toBe(7_000);
    });

    it("prefers explicit retry.perCallTimeoutMs over configRetry and channel timeout", async () => {
      const observed = await capturePerCallTimeoutMs({
        retry: {
          attempts: 1,
          minDelayMs: 0,
          maxDelayMs: 0,
          jitter: 0,
          perCallTimeoutMs: 4_000,
        },
        configRetry: { perCallTimeoutMs: 7_000 },
        channelTimeoutSeconds: 12,
      });
      expect(observed).toBe(4_000);
    });

    it("ignores non-positive channelTimeoutSeconds and uses the channel default", async () => {
      const observed = await capturePerCallTimeoutMs({
        retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        channelTimeoutSeconds: 0,
      });
      expect(observed).toBe(30_000);
    });
  });

  it("honors nested retry_after hints before retrying", async () => {
    vi.useFakeTimers();

    const runner = createChannelApiRetryRunner({
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

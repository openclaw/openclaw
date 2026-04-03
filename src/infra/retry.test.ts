import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRetryConfig, retryAsync } from "./retry.js";

const randomMocks = vi.hoisted(() => ({
  generateSecureFraction: vi.fn(),
}));

vi.mock("./secure-random.js", () => ({
  generateSecureFraction: randomMocks.generateSecureFraction,
}));

type NumberRetryCase = {
  name: string;
  fn: ReturnType<typeof vi.fn>;
  attempts: number;
  initialDelayMs: number;
  expectedValue?: string;
  expectedError?: string;
  expectedCalls: number;
};

async function runRetryAfterCase(params: {
  minDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: number;
  error?: Error;
}): Promise<number[]> {
  vi.clearAllTimers();
  vi.useFakeTimers();
  try {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(params.error ?? new Error("boom"))
      .mockResolvedValueOnce("ok");
    const delays: number[] = [];
    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: params.minDelayMs,
      maxDelayMs: params.maxDelayMs,
      jitter: 0,
      ...(params.retryAfterMs === undefined ? {} : { retryAfterMs: () => params.retryAfterMs }),
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    return delays;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

async function runRetryNumberCase(
  fn: ReturnType<typeof vi.fn>,
  attempts: number,
  initialDelayMs: number,
): Promise<unknown> {
  vi.clearAllTimers();
  vi.useFakeTimers();
  try {
    const promise = retryAsync(fn as () => Promise<unknown>, attempts, initialDelayMs);
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if (result.ok) {
      return result.value;
    }
    throw result.error;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  randomMocks.generateSecureFraction.mockReset();
});

describe("retryAsync", () => {
  it.each<NumberRetryCase>([
    {
      name: "returns on first success",
      fn: vi.fn().mockResolvedValue("ok"),
      attempts: 3,
      initialDelayMs: 10,
      expectedValue: "ok",
      expectedCalls: 1,
    },
    {
      name: "retries then succeeds",
      fn: vi.fn().mockRejectedValueOnce(new Error("fail1")).mockResolvedValueOnce("ok"),
      attempts: 3,
      initialDelayMs: 1,
      expectedValue: "ok",
      expectedCalls: 2,
    },
    {
      name: "propagates after exhausting retries",
      fn: vi.fn().mockRejectedValue(new Error("boom")),
      attempts: 2,
      initialDelayMs: 1,
      expectedError: "boom",
      expectedCalls: 2,
    },
  ])(
    "$name",
    async ({ fn, attempts, initialDelayMs, expectedValue, expectedError, expectedCalls }) => {
      const result = runRetryNumberCase(fn, attempts, initialDelayMs);
      if (expectedError) {
        await expect(result).rejects.toThrow(expectedError);
      } else {
        await expect(result).resolves.toBe(expectedValue);
      }
      expect(fn).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it("stops when shouldRetry returns false", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);
    const shouldRetry = vi.fn(() => false);
    await expect(retryAsync(fn, { attempts: 3, shouldRetry })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(err, 1);
  });

  it("calls onRetry with retry metadata before retrying", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    vi.clearAllTimers();
    vi.useFakeTimers();
    let res: string;
    try {
      const promise: Promise<string> = retryAsync(fn, {
        attempts: 2,
        minDelayMs: 0,
        maxDelayMs: 0,
        label: "telegram",
        onRetry,
      });
      await vi.runAllTimersAsync();
      res = await promise;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    expect(res).toBe("ok");
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 2,
        err,
        label: "telegram",
      }),
    );
  });

  it("clamps attempts to at least 1", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryAsync(fn, { attempts: 0, minDelayMs: 0, maxDelayMs: 0 })).rejects.toThrow(
      "boom",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "uses retryAfterMs when provided",
      params: { minDelayMs: 0, maxDelayMs: 1000, retryAfterMs: 500 },
      expectedDelay: 500,
    },
    {
      name: "clamps retryAfterMs to maxDelayMs",
      params: { minDelayMs: 0, maxDelayMs: 100, retryAfterMs: 500 },
      expectedDelay: 100,
    },
    {
      name: "clamps retryAfterMs to minDelayMs",
      params: { minDelayMs: 250, maxDelayMs: 1000, retryAfterMs: 50 },
      expectedDelay: 250,
    },
  ])("$name", async ({ params, expectedDelay }) => {
    const delays = await runRetryAfterCase(params);
    expect(delays[0]).toBe(expectedDelay);
  });

  it("uses secure jitter when configured", async () => {
    vi.useFakeTimers();
    randomMocks.generateSecureFraction.mockReturnValue(1);
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const delays: number[] = [];

    try {
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
      expect(randomMocks.generateSecureFraction).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("treats numeric err.retryAfter as seconds", async () => {
    const err = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      retryAfter: 2,
    });
    const delays = await runRetryAfterCase({ minDelayMs: 0, maxDelayMs: 5000, error: err });
    expect(delays[0]).toBe(2000);
  });

  it("keeps numeric err.retryAfterMs in milliseconds", async () => {
    const err = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      retryAfterMs: 250,
    });
    const delays = await runRetryAfterCase({ minDelayMs: 0, maxDelayMs: 5000, error: err });
    expect(delays[0]).toBe(250);
  });

  it("honors retry-after from 429 errors even without retryAfterMs option", async () => {
    const err = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      headers: { "retry-after": "2" },
    });
    const delays = await runRetryAfterCase({ minDelayMs: 0, maxDelayMs: 5000, error: err });
    expect(delays[0]).toBe(2000);
  });

  it("honors retry-after when 429 is nested under response.status", async () => {
    const err = Object.assign(new Error("request failed"), {
      response: { status: 429, headers: { "retry-after": "2" } },
    });
    const delays = await runRetryAfterCase({ minDelayMs: 0, maxDelayMs: 5000, error: err });
    expect(delays[0]).toBe(2000);
  });

  it("honors retry-after when nested response status is a numeric string", async () => {
    const err = Object.assign(new Error("request failed"), {
      response: { status: "429", headers: { "retry-after": "2" } },
    });
    const delays = await runRetryAfterCase({ minDelayMs: 0, maxDelayMs: 5000, error: err });
    expect(delays[0]).toBe(2000);
  });

  it("honors retry after hints in rate-limit style messages", async () => {
    const delays = await runRetryAfterCase({
      minDelayMs: 0,
      maxDelayMs: 5000,
      error: new Error("rate limited, retry after 3 seconds"),
    });
    expect(delays[0]).toBe(3000);
  });

  it("parses millisecond retry after hints in rate-limit style messages", async () => {
    const delays = await runRetryAfterCase({
      minDelayMs: 0,
      maxDelayMs: 5000,
      error: new Error("rate limited, retry after 500 ms"),
    });
    expect(delays[0]).toBe(500);
  });

  it("parses retry-after-ms key hints in rate-limit style messages as milliseconds", async () => {
    const delays = await runRetryAfterCase({
      minDelayMs: 0,
      maxDelayMs: 5000,
      error: new Error("rate limited, retry-after-ms=500"),
    });
    expect(delays[0]).toBe(500);
  });

  it("parses fractional second retry after hints in rate-limit style messages", async () => {
    const delays = await runRetryAfterCase({
      minDelayMs: 0,
      maxDelayMs: 5000,
      error: new Error("rate limited, retry after 1.5s"),
    });
    expect(delays[0]).toBe(1500);
  });

  it("parses minute-based retry after hints in rate-limit style messages", async () => {
    const delays = await runRetryAfterCase({
      minDelayMs: 0,
      maxDelayMs: 200_000,
      error: new Error("rate limited, retry after 2 minutes"),
    });
    expect(delays[0]).toBe(120_000);
  });

  it("parses abbreviated minute retry after hints in rate-limit style messages", async () => {
    const delays = await runRetryAfterCase({
      minDelayMs: 0,
      maxDelayMs: 200_000,
      error: new Error("rate limited, retry after 2 min"),
    });
    expect(delays[0]).toBe(120_000);
  });

  it("accepts string-valued retryAfter fields", async () => {
    const err = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      retryAfter: "3",
    });
    const delays = await runRetryAfterCase({ minDelayMs: 0, maxDelayMs: 5000, error: err });
    expect(delays[0]).toBe(3000);
  });

  it("parses HTTP-date retry-after hints embedded in error messages", async () => {
    const future = new Date(Date.now() + 4000).toUTCString();
    const delays = await runRetryAfterCase({
      minDelayMs: 0,
      maxDelayMs: 5000,
      error: new Error(`rate limited, Retry-After: ${future}`),
    });
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThanOrEqual(5000);
  });
});

describe("resolveRetryConfig", () => {
  it.each([
    {
      name: "rounds attempts and delays",
      overrides: { attempts: 2.6, minDelayMs: 10.4, maxDelayMs: 99.8, jitter: 0.4 },
      expected: { attempts: 3, minDelayMs: 10, maxDelayMs: 100, jitter: 0.4 },
    },
    {
      name: "clamps attempts to at least one and maxDelayMs to minDelayMs",
      overrides: { attempts: 0, minDelayMs: 250, maxDelayMs: 100, jitter: -1 },
      expected: { attempts: 1, minDelayMs: 250, maxDelayMs: 250, jitter: 0 },
    },
    {
      name: "falls back for non-finite overrides and caps jitter at one",
      overrides: {
        attempts: Number.NaN,
        minDelayMs: Number.POSITIVE_INFINITY,
        maxDelayMs: Number.NaN,
        jitter: 2,
      },
      expected: { attempts: 3, minDelayMs: 300, maxDelayMs: 30000, jitter: 1 },
    },
  ])("$name", ({ overrides, expected }) => {
    expect(resolveRetryConfig(undefined, overrides)).toEqual(expected);
  });
});

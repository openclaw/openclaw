import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  parseProviderError,
  retryWithBackoff,
} from "./provider-error.js";
import type { ProviderError, RetryPolicy } from "./provider-error.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(
  status: number,
  headers: Record<string, string> = {},
  body: unknown = null,
): Response {
  const bodyStr = body !== null ? JSON.stringify(body) : "";
  return new Response(bodyStr || null, {
    status,
    headers: new Headers(headers),
  });
}

function makeRetryableError(overrides: Partial<ProviderError> = {}): ProviderError {
  return {
    provider: "anthropic",
    httpStatus: 429,
    category: "rate-limit",
    retryAfterMs: null,
    message: "Anthropic Rate limited. Retrying with backoff...",
    retryable: true,
    raw: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseProviderError
// ---------------------------------------------------------------------------

describe("parseProviderError", () => {
  describe("rate-limit (429)", () => {
    it("numeric retry-after header → retryAfterMs = header * 1000", async () => {
      const res = mockResponse(429, { "retry-after": "30" });
      const err = await parseProviderError("anthropic", res);
      expect(err.category).toBe("rate-limit");
      expect(err.httpStatus).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(30000);
      expect(err.message).toContain("30s");
    });

    it("HTTP-date retry-after header → retryAfterMs > 0", async () => {
      const future = new Date(Date.now() + 60000).toUTCString();
      const res = mockResponse(429, { "retry-after": future });
      const err = await parseProviderError("openai", res);
      expect(err.retryAfterMs).toBeGreaterThan(0);
      expect(err.retryable).toBe(true);
    });

    it("no retry-after header → retryAfterMs = null, message contains 'backoff'", async () => {
      const res = mockResponse(429);
      const err = await parseProviderError("openai", res);
      expect(err.retryAfterMs).toBeNull();
      expect(err.message).toContain("backoff");
    });

    it("category is rate-limit, httpStatus is 429", async () => {
      const res = mockResponse(429);
      const err = await parseProviderError("openrouter", res);
      expect(err.category).toBe("rate-limit");
      expect(err.httpStatus).toBe(429);
    });
  });

  describe("resource-exhaustion (503)", () => {
    it("category, retryable, retryAfterMs, message", async () => {
      const res = mockResponse(503);
      const err = await parseProviderError("ollama", res);
      expect(err.category).toBe("resource-exhaustion");
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBeNull();
      expect(err.message).toContain("exhausted");
    });
  });

  describe("auth errors", () => {
    it("401 → auth, not retryable, message contains 'Authentication failed'", async () => {
      const res = mockResponse(401);
      const err = await parseProviderError("anthropic", res);
      expect(err.category).toBe("auth");
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("Authentication failed");
    });

    it("403 → auth, not retryable, message contains 'Access denied'", async () => {
      const res = mockResponse(403);
      const err = await parseProviderError("anthropic", res);
      expect(err.category).toBe("auth");
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("Access denied");
    });
  });

  describe("client-error (400)", () => {
    it("400 → client-error, not retryable, message contains 'Bad request'", async () => {
      const res = mockResponse(400);
      const err = await parseProviderError("openai", res);
      expect(err.category).toBe("client-error");
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("Bad request");
    });
  });

  describe("unknown (5xx etc)", () => {
    it("500 → unknown, not retryable", async () => {
      const res = mockResponse(500);
      const err = await parseProviderError("openai", res);
      expect(err.category).toBe("unknown");
      expect(err.retryable).toBe(false);
    });
  });

  describe("provider label capitalization", () => {
    it("'anthropic' → message starts with 'Anthropic'", async () => {
      const res = mockResponse(429);
      const err = await parseProviderError("anthropic", res);
      expect(err.message.startsWith("Anthropic")).toBe(true);
    });

    it("'ollama' → message starts with 'Ollama'", async () => {
      const res = mockResponse(503);
      const err = await parseProviderError("ollama", res);
      expect(err.message.startsWith("Ollama")).toBe(true);
    });
  });

  describe("body parsing", () => {
    it("JSON body is preserved in raw", async () => {
      const body = { error: { type: "rate_limit_error", message: "slow down" } };
      const res = mockResponse(429, {}, body);
      const err = await parseProviderError("anthropic", res);
      expect(err.raw).toEqual(body);
    });

    it("non-JSON body → raw === null, no throw", async () => {
      const res = new Response("not json", { status: 429 });
      const err = await parseProviderError("anthropic", res);
      expect(err.raw).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------

describe("retryWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("non-retryable error → throws immediately, fn never called", async () => {
    const fn = vi.fn<() => Promise<string>>();
    const err = makeRetryableError({ retryable: false, category: "auth" });

    await expect(retryWithBackoff(fn, DEFAULT_RETRY_POLICY, err)).rejects.toMatchObject({
      retryable: false,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("retryable with retryAfterMs: fn fails then succeeds → returns result", async () => {
    const providerErr = makeRetryableError({ retryAfterMs: 5000 });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw providerErr;
      return "ok";
    });

    const promise = retryWithBackoff(fn, DEFAULT_RETRY_POLICY, providerErr);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("onRetry called with retryAfterMs delay on first attempt", async () => {
    const providerErr = makeRetryableError({ retryAfterMs: 5000 });
    const delays: number[] = [];
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw providerErr;
      return "ok";
    });

    const promise = retryWithBackoff(fn, DEFAULT_RETRY_POLICY, providerErr, (_attempt, _max, delayMs) => {
      delays.push(delayMs);
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(delays[0]).toBe(5000);
  });

  it("fn fails all maxRetries → throws last error", async () => {
    const providerErr = makeRetryableError({ retryAfterMs: null });
    const fn = vi.fn(async (): Promise<string> => {
      throw providerErr;
    });

    let caught: unknown;
    const promise = retryWithBackoff(fn, DEFAULT_RETRY_POLICY, providerErr).catch((e) => {
      caught = e;
    });
    await vi.runAllTimersAsync();
    await promise;
    expect((caught as ProviderError).category).toBe("rate-limit");
    expect(fn).toHaveBeenCalledTimes(DEFAULT_RETRY_POLICY.maxRetries);
  });

  it("onRetry called with increasing backoff delays (2000, 4000, 8000)", async () => {
    const providerErr = makeRetryableError({ retryAfterMs: null });
    const delays: number[] = [];
    const fn = vi.fn(async (): Promise<string> => {
      throw providerErr;
    });

    const promise = retryWithBackoff(fn, DEFAULT_RETRY_POLICY, providerErr, (_attempt, _max, delayMs) => {
      delays.push(delayMs);
    }).catch(() => { /* expected */ });
    await vi.runAllTimersAsync();
    await promise;
    expect(delays).toEqual([2000, 4000, 8000]);
  });

  it("fn succeeds on first retry → returns result, onRetry called once", async () => {
    const providerErr = makeRetryableError({ retryAfterMs: null });
    let retryCalls = 0;
    const fn = vi.fn(async () => "success");

    const promise = retryWithBackoff(fn, DEFAULT_RETRY_POLICY, providerErr, () => {
      retryCalls++;
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("success");
    expect(retryCalls).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("non-ProviderError thrown mid-retry → rethrows immediately", async () => {
    const providerErr = makeRetryableError({ retryAfterMs: null });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw providerErr;
      throw new Error("unexpected failure");
    });

    let caught: unknown;
    const promise = retryWithBackoff(fn, DEFAULT_RETRY_POLICY, providerErr).catch((e) => {
      caught = e;
    });
    await vi.runAllTimersAsync();
    await promise;
    expect((caught as Error).message).toBe("unexpected failure");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("DEFAULT_RETRY_POLICY has correct values", () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(2000);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBe(60000);
    expect(DEFAULT_RETRY_POLICY.backoffMultiplier).toBe(2.0);
  });
});

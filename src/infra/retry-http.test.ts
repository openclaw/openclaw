import { describe, expect, it, vi } from "vitest";
import { retryHttpAsync, isHttpRetryable } from "./retry-http.js";

// Mock the lower-level retryAsync to control its behavior in isolation
vi.unstubAllEnvs();
vi.unstubAllGlobals();

class MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body?: unknown;
  constructor(opts: { ok?: boolean; status?: number; statusText?: string; body?: unknown } = {}) {
    this.ok = opts.ok ?? true;
    this.status = opts.status ?? 200;
    this.statusText = opts.statusText ?? "OK";
    this.body = opts.body;
  }
  async text() {
    return typeof this.body === "string" ? this.body : "";
  }
}

describe("retryHttpAsync", () => {
  it("returns transformed result on success", async () => {
    const mockRetry = vi.fn().mockResolvedValue(new MockResponse({ status: 200 }));
    const logger = vi.fn();
    const options = {
      label: "test",
      logger,
    } as const;

    const result = await retryHttpAsync(mockRetry, options);
    // defaultResponseTransformer returns the Response itself
    expect(result).toBeInstanceOf(MockResponse);
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("validates response and throws on non-OK", async () => {
    const mockRetry = vi
      .fn()
      .mockResolvedValue(new MockResponse({ ok: false, status: 500, body: "error" }));
    const logger = vi.fn();
    const options = {
      label: "test",
      logger,
    } as const;

    await expect(retryHttpAsync(mockRetry, options)).rejects.toThrow("HTTP 500");
  });

  it("retries on retryable network errors", async () => {
    const mockRetry = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" } as unknown),
      )
      .mockResolvedValue(new MockResponse({ ok: true }));
    const logger = vi.fn();
    const options = {
      label: "test",
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 1,
      logger,
    } as const;

    const result = await retryHttpAsync(mockRetry, options);
    expect(result).toBeInstanceOf(MockResponse);
    expect(mockRetry).toHaveBeenCalledTimes(2);
  });

  it("retries on retryable HTTP status codes and succeeds on retry", async () => {
    const mockRetry = vi
      .fn()
      .mockResolvedValueOnce(new MockResponse({ ok: false, status: 429 }))
      .mockResolvedValueOnce(new MockResponse({ ok: true, status: 200 }));
    const logger = vi.fn();
    const options = {
      label: "test",
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 1,
      logger,
    } as const;

    const result = await retryHttpAsync(mockRetry, options);
    expect(result).toBeInstanceOf(MockResponse);
    expect((result as MockResponse).status).toBe(200);
    expect(mockRetry).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-retryable errors", async () => {
    const mockRetry = vi.fn().mockRejectedValue(new Error("EACCES"));
    const logger = vi.fn();
    const options = {
      label: "test",
      attempts: 3,
      minDelayMs: 0,
      maxDelayMs: 1,
      logger,
      shouldRetry: isHttpRetryable,
    } as const;

    await expect(retryHttpAsync(mockRetry, options)).rejects.toThrow("EACCES");
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("propagates TypeError as retryable", async () => {
    const mockRetry = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(new MockResponse({ ok: true }));
    const logger = vi.fn();
    const options = {
      label: "test",
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 1,
      logger,
    } as const;

    const result = await retryHttpAsync(mockRetry, options);
    expect(result).toBeInstanceOf(MockResponse);
    expect(mockRetry).toHaveBeenCalledTimes(2);
  });

  it("uses default logger when none provided", async () => {
    const mockRetry = vi.fn().mockResolvedValue(new MockResponse({ ok: true }));
    // No logger passed; should default to console.warn (which we don't call on success)
    const options = {
      label: "test",
    } as const;

    await retryHttpAsync(mockRetry, options);
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("calls logger on retry", async () => {
    const mockRetry = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(new MockResponse({ ok: true }));
    const logger = vi.fn();
    const options = {
      label: "test",
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 1,
      logger,
    } as const;

    await retryHttpAsync(mockRetry, options);
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/Retry 1\/2 failed/));
  });

  it("applies transformResponse to convert Response to body", async () => {
    const mockRetry = vi.fn().mockResolvedValue(new MockResponse({ status: 200, body: "hello" }));
    const options = {
      label: "test",
      transformResponse: async (res: Response) => res.body,
    } as const;

    const result = await retryHttpAsync(mockRetry, options);
    expect(result).toBe("hello");
  });

  it("uses custom createError", async () => {
    const mockRetry = vi.fn().mockResolvedValue(new MockResponse({ ok: false, status: 500 }));
    const options = {
      label: "test",
      createError: async (res: Response) => new Error(`Custom ${res.status}`),
    } as const;

    await expect(retryHttpAsync(mockRetry, options)).rejects.toThrow("Custom 500");
  });

  it("does not retry on non-retryable HTTP status (400)", async () => {
    const mockRetry = vi.fn().mockResolvedValue(new MockResponse({ ok: false, status: 400 }));
    const options = {
      label: "test",
      attempts: 3,
      minDelayMs: 0,
      maxDelayMs: 1,
      shouldRetry: isHttpRetryable,
    } as const;

    await expect(retryHttpAsync(mockRetry, options)).rejects.toThrow("HTTP 400");
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("respects custom shouldRetry returning false", async () => {
    const mockRetry = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("fail"), { code: "ECONNRESET" }))
      .mockResolvedValue(new MockResponse({ ok: true }));
    const options = {
      label: "test",
      attempts: 2,
      shouldRetry: () => false,
      minDelayMs: 0,
      maxDelayMs: 1,
    } as const;

    await expect(retryHttpAsync(mockRetry, options)).rejects.toThrow("fail");
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("uses retryAfterMs if provided", async () => {
    const mockRetry = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate-limit"), { status: 429 }))
      .mockResolvedValue(new MockResponse({ ok: true }));
    const options = {
      label: "test",
      attempts: 2,
      minDelayMs: 1,
      maxDelayMs: 100,
      retryAfterMs: (err: unknown) =>
        err instanceof Error && err.message === "rate-limit" ? 50 : undefined,
    } as const;

    const start = Date.now();
    await retryHttpAsync(mockRetry, options);
    const elapsed = Date.now() - start;
    // With retryAfterMs returning 50, we expect roughly 50ms delay + call overhead
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(mockRetry).toHaveBeenCalledTimes(2);
  });

  it("calls onRetry callback with correct info", async () => {
    const mockRetry = vi
      .fn()
      .mockRejectedValueOnce({ code: "ECONNRESET" } as unknown as TypeError)
      .mockResolvedValue(new MockResponse({ ok: true }));
    const onRetry = vi.fn();
    const options = {
      label: "api",
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 1,
      onRetry,
    } as const;

    await expect(retryHttpAsync(mockRetry, options)).resolves.toBeInstanceOf(MockResponse);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 2,
        err: expect.any(Object),
        label: "api",
      }),
    );
  });
});

describe("isHttpRetryable", () => {
  it("returns false for generic TypeError (not a fetch failure)", () => {
    expect(isHttpRetryable(new TypeError("some other error"))).toBe(false);
    expect(isHttpRetryable(new TypeError())).toBe(false);
  });

  it("returns true for TypeError with 'fetch failed' message", () => {
    expect(isHttpRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isHttpRetryable(new TypeError("Fetch failed"))).toBe(true);
    expect(isHttpRetryable(new TypeError("FETCH FAILED"))).toBe(true);
  });

  it("returns true for known network error codes", () => {
    expect(isHttpRetryable({ code: "ECONNRESET" } as unknown)).toBe(true);
    expect(isHttpRetryable({ code: "ETIMEDOUT" } as unknown)).toBe(true);
    expect(isHttpRetryable({ code: "ECONNREFUSED" } as unknown)).toBe(true);
    expect(isHttpRetryable({ code: "ENETUNREACH" } as unknown)).toBe(true);
  });

  it("returns true for retryable HTTP status codes", () => {
    expect(isHttpRetryable({ status: 429 } as unknown)).toBe(true);
    expect(isHttpRetryable({ status: 500 } as unknown)).toBe(true);
    expect(isHttpRetryable({ status: 502 } as unknown)).toBe(true);
    expect(isHttpRetryable({ status: 503 } as unknown)).toBe(true);
    expect(isHttpRetryable({ status: 504 } as unknown)).toBe(true);
    expect(isHttpRetryable({ status: 522 } as unknown)).toBe(true);
    expect(isHttpRetryable({ status: 524 } as unknown)).toBe(true);
  });

  it("returns false for non-retryable HTTP status codes", () => {
    expect(isHttpRetryable({ status: 400 } as unknown)).toBe(false);
    expect(isHttpRetryable({ status: 401 } as unknown)).toBe(false);
    expect(isHttpRetryable({ status: 404 } as unknown)).toBe(false);
  });

  it("returns false for unknown errors", () => {
    expect(isHttpRetryable(new Error("other"))).toBe(false);
  });
});

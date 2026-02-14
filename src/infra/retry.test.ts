import { describe, expect, it, vi } from "vitest";
import { RetryExhaustedError, retryPredicates, withRetry } from "./retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const operation = vi.fn().mockResolvedValue("success");

    const result = await withRetry(operation);

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds eventually", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("success");

    const result = await withRetry(operation, {
      maxAttempts: 3,
      backoffPolicy: { initialMs: 1, maxMs: 10, factor: 2, jitter: 0 },
    });

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("throws RetryExhaustedError when all attempts fail", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      withRetry(operation, {
        maxAttempts: 3,
        backoffPolicy: { initialMs: 1, maxMs: 10, factor: 2, jitter: 0 },
      }),
    ).rejects.toThrow(RetryExhaustedError);

    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("throws immediately when shouldRetry returns false", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("non-retryable"));
    const shouldRetry = vi.fn().mockReturnValue(false);

    await expect(
      withRetry(operation, {
        maxAttempts: 3,
        shouldRetry,
      }),
    ).rejects.toThrow("non-retryable");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry callback with correct arguments", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockResolvedValue("success");
    const onRetry = vi.fn();

    await withRetry(operation, {
      maxAttempts: 2,
      backoffPolicy: { initialMs: 100, maxMs: 1000, factor: 2, jitter: 0 },
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 100);
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const operation = vi.fn().mockResolvedValue("success");

    await expect(
      withRetry(operation, {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("aborted");

    expect(operation).not.toHaveBeenCalled();
  });

  it("handles non-Error throws", async () => {
    const operation = vi.fn().mockRejectedValue("string error");

    await expect(
      withRetry(operation, {
        maxAttempts: 1,
      }),
    ).rejects.toThrow(RetryExhaustedError);
  });
});

describe("retryPredicates", () => {
  describe("networkErrors", () => {
    it("returns true for network errors", () => {
      expect(retryPredicates.networkErrors(new Error("ECONNRESET"))).toBe(true);
      expect(retryPredicates.networkErrors(new Error("connection timeout"))).toBe(true);
      expect(retryPredicates.networkErrors(new Error("ETIMEDOUT"))).toBe(true);
      expect(retryPredicates.networkErrors(new Error("DNS lookup failed"))).toBe(true);
    });

    it("returns false for non-network errors", () => {
      expect(retryPredicates.networkErrors(new Error("Invalid input"))).toBe(false);
      expect(retryPredicates.networkErrors(new Error("Not found"))).toBe(false);
    });
  });

  describe("serverErrors", () => {
    it("returns true for 5xx status codes", () => {
      const err500 = Object.assign(new Error("Server error"), { status: 500 });
      const err503 = Object.assign(new Error("Unavailable"), { statusCode: 503 });

      expect(retryPredicates.serverErrors(err500)).toBe(true);
      expect(retryPredicates.serverErrors(err503)).toBe(true);
    });

    it("returns true for 429 rate limit", () => {
      const err429 = Object.assign(new Error("Too many requests"), { status: 429 });
      expect(retryPredicates.serverErrors(err429)).toBe(true);
    });

    it("returns false for 4xx errors (except 429)", () => {
      const err400 = Object.assign(new Error("Bad request"), { status: 400 });
      const err404 = Object.assign(new Error("Not found"), { status: 404 });

      expect(retryPredicates.serverErrors(err400)).toBe(false);
      expect(retryPredicates.serverErrors(err404)).toBe(false);
    });

    it("returns false when no status", () => {
      expect(retryPredicates.serverErrors(new Error("No status"))).toBe(false);
    });
  });

  describe("any", () => {
    it("combines predicates with OR logic", () => {
      const combined = retryPredicates.any(
        retryPredicates.networkErrors,
        retryPredicates.serverErrors,
      );

      expect(combined(new Error("ECONNRESET"), 1)).toBe(true);
      expect(
        combined(Object.assign(new Error("Server error"), { status: 500 }), 1),
      ).toBe(true);
      expect(combined(new Error("Invalid input"), 1)).toBe(false);
    });
  });
});

describe("RetryExhaustedError", () => {
  it("contains attempt count and last error", () => {
    const lastError = new Error("final failure");
    const error = new RetryExhaustedError(3, lastError);

    expect(error.attempts).toBe(3);
    expect(error.lastError).toBe(lastError);
    expect(error.name).toBe("RetryExhaustedError");
    expect(error.message).toContain("3 retry attempts");
    expect(error.message).toContain("final failure");
  });
});

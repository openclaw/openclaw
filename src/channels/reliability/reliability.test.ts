/**
 * Unit tests for reliability module.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ChannelError,
  ChannelErrorCode,
  isChannelError,
  isRecoverableChannelError,
  detectErrorCode,
  wrapAsChannelError,
} from "./errors.js";
import {
  createInMemoryIdempotencyStore,
  buildIdempotencyKey,
  withIdempotency,
} from "./idempotency.js";
import { calculateBackoff, DEFAULT_RETRY_POLICY, withRetry, withRetryResult } from "./retry.js";

// =============================================================================
// Retry Tests
// =============================================================================

describe("retry", () => {
  describe("calculateBackoff", () => {
    it("should calculate exponential backoff with jitter", () => {
      const policy = { ...DEFAULT_RETRY_POLICY, jitterFactor: 0 };

      expect(calculateBackoff(0, policy)).toBe(1000); // base delay
      expect(calculateBackoff(1, policy)).toBe(2000); // 2^1 * base
      expect(calculateBackoff(2, policy)).toBe(4000); // 2^2 * base
    });

    it("should cap at maxDelayMs", () => {
      const policy = { ...DEFAULT_RETRY_POLICY, jitterFactor: 0, maxDelayMs: 5000 };

      expect(calculateBackoff(0, policy)).toBe(1000);
      expect(calculateBackoff(10, policy)).toBe(5000); // capped
    });

    it("should add jitter within range", () => {
      const policy = { ...DEFAULT_RETRY_POLICY, jitterFactor: 0.2 };

      for (let i = 0; i < 10; i++) {
        const delay = calculateBackoff(0, policy);
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(1200); // 1000 * (1 + 0.2)
      }
    });
  });

  describe("withRetry", () => {
    it("should return result on first success", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const isRecoverable = () => true;
      const ctx = { correlationId: "test-1", channel: "test", operation: "send" };

      const result = await withRetry(fn, DEFAULT_RETRY_POLICY, isRecoverable, ctx);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on recoverable error", async () => {
      const fn = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue("success");
      const isRecoverable = () => true;
      const ctx = { correlationId: "test-2", channel: "test", operation: "send" };

      const result = await withRetry(
        fn,
        { ...DEFAULT_RETRY_POLICY, baseDelayMs: 10 },
        isRecoverable,
        ctx,
      );

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should throw immediately on non-recoverable error", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("auth failed"));
      const isRecoverable = () => false;
      const ctx = { correlationId: "test-3", channel: "test", operation: "send" };

      await expect(withRetry(fn, DEFAULT_RETRY_POLICY, isRecoverable, ctx)).rejects.toThrow(
        "auth failed",
      );

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should throw after max attempts", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("timeout"));
      const isRecoverable = () => true;
      const ctx = { correlationId: "test-4", channel: "test", operation: "send" };
      const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, baseDelayMs: 10 };

      await expect(withRetry(fn, policy, isRecoverable, ctx)).rejects.toThrow("timeout");

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("withRetryResult", () => {
    it("should return success result", async () => {
      const fn = vi.fn().mockResolvedValue("data");
      const ctx = { correlationId: "test-5", channel: "test", operation: "fetch" };

      const result = await withRetryResult(fn, DEFAULT_RETRY_POLICY, () => true, ctx);

      expect(result.success).toBe(true);
      expect(result.value).toBe("data");
      expect(result.attempts).toBe(1);
    });

    it("should return failure result without throwing", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fail"));
      const ctx = { correlationId: "test-6", channel: "test", operation: "fetch" };
      const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 };

      const result = await withRetryResult(fn, policy, () => true, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.attempts).toBe(1);
    });
  });
});

// =============================================================================
// Idempotency Tests
// =============================================================================

describe("idempotency", () => {
  describe("buildIdempotencyKey", () => {
    it("should combine channel and message ID", () => {
      expect(buildIdempotencyKey("telegram", "msg-123")).toBe("telegram:msg-123");
      expect(buildIdempotencyKey("discord", "456")).toBe("discord:456");
    });
  });

  describe("createInMemoryIdempotencyStore", () => {
    it("should track processed keys", async () => {
      const store = createInMemoryIdempotencyStore();
      const key = "test:1";

      expect(await store.has(key)).toBe(false);

      await store.set(key, 60000);
      expect(await store.has(key)).toBe(true);
    });

    it("should expire keys after TTL", async () => {
      vi.useFakeTimers();

      const store = createInMemoryIdempotencyStore(100, 0);
      const key = "test:2";

      await store.set(key, 1000);
      expect(await store.has(key)).toBe(true);

      vi.advanceTimersByTime(1001);
      expect(await store.has(key)).toBe(false);

      vi.useRealTimers();
    });

    it("should allow deletion", async () => {
      const store = createInMemoryIdempotencyStore();
      const key = "test:3";

      await store.set(key, 60000);
      expect(await store.has(key)).toBe(true);

      await store.delete(key);
      expect(await store.has(key)).toBe(false);
    });

    it("should prune on max capacity", async () => {
      const store = createInMemoryIdempotencyStore(2, 0);

      await store.set("a", 60000);
      await store.set("b", 60000);
      expect(store.size()).toBe(2);

      await store.set("c", 60000);
      expect(store.size()).toBeLessThanOrEqual(3);
    });
  });

  describe("withIdempotency", () => {
    it("should execute function for new key", async () => {
      const store = createInMemoryIdempotencyStore();
      const fn = vi.fn().mockResolvedValue("result");

      const { executed, result } = await withIdempotency(store, "key-1", fn);

      expect(executed).toBe(true);
      expect(result).toBe("result");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should skip execution for duplicate key", async () => {
      const store = createInMemoryIdempotencyStore();
      const fn = vi.fn().mockResolvedValue("result");

      await withIdempotency(store, "key-2", fn);
      const { executed } = await withIdempotency(store, "key-2", fn);

      expect(executed).toBe(false);
      expect(fn).toHaveBeenCalledTimes(1); // Only called once
    });

    it("should remove key on error for retry", async () => {
      const store = createInMemoryIdempotencyStore();
      const fn = vi.fn().mockRejectedValue(new Error("fail"));

      await expect(withIdempotency(store, "key-3", fn)).rejects.toThrow("fail");
      expect(await store.has("key-3")).toBe(false); // Key removed
    });
  });
});

// =============================================================================
// Error Tests
// =============================================================================

describe("errors", () => {
  describe("ChannelError", () => {
    it("should create error with all properties", () => {
      const err = new ChannelError(
        ChannelErrorCode.RATE_LIMITED,
        "Too many requests",
        "corr-123",
        "telegram",
        { retryAfterMs: 5000 },
      );

      expect(err.code).toBe(ChannelErrorCode.RATE_LIMITED);
      expect(err.message).toBe("Too many requests");
      expect(err.correlationId).toBe("corr-123");
      expect(err.channel).toBe("telegram");
      expect(err.recoverable).toBe(true);
      expect(err.retryAfterMs).toBe(5000);
    });

    it("should serialize to JSON", () => {
      const err = new ChannelError(
        ChannelErrorCode.AUTH_EXPIRED,
        "Token expired",
        "corr-456",
        "slack",
      );

      const json = err.toJSON();
      expect(json.code).toBe("AUTH_EXPIRED");
      expect(json.recoverable).toBe(false);
    });
  });

  describe("isChannelError", () => {
    it("should identify ChannelError instances", () => {
      const channelErr = new ChannelError(ChannelErrorCode.UNKNOWN, "test", "id", "ch");
      const regularErr = new Error("test");

      expect(isChannelError(channelErr)).toBe(true);
      expect(isChannelError(regularErr)).toBe(false);
      expect(isChannelError(null)).toBe(false);
    });
  });

  describe("isRecoverableChannelError", () => {
    it("should identify recoverable errors", () => {
      const recoverable = new ChannelError(ChannelErrorCode.NETWORK_TIMEOUT, "timeout", "id", "ch");
      const permanent = new ChannelError(ChannelErrorCode.AUTH_EXPIRED, "auth", "id", "ch");

      expect(isRecoverableChannelError(recoverable)).toBe(true);
      expect(isRecoverableChannelError(permanent)).toBe(false);
      expect(isRecoverableChannelError(new Error("test"))).toBe(false);
    });
  });

  describe("detectErrorCode", () => {
    it("should detect timeout errors", () => {
      expect(detectErrorCode({ code: "ETIMEDOUT" })).toBe(ChannelErrorCode.NETWORK_TIMEOUT);
      expect(detectErrorCode({ message: "Connection timeout" })).toBe(
        ChannelErrorCode.NETWORK_TIMEOUT,
      );
    });

    it("should detect rate limit errors", () => {
      expect(detectErrorCode({ status: 429 })).toBe(ChannelErrorCode.RATE_LIMITED);
      expect(detectErrorCode({ message: "rate limit exceeded" })).toBe(
        ChannelErrorCode.RATE_LIMITED,
      );
    });

    it("should detect auth errors", () => {
      expect(detectErrorCode({ status: 401 })).toBe(ChannelErrorCode.AUTH_EXPIRED);
      expect(detectErrorCode({ status: 403 })).toBe(ChannelErrorCode.AUTH_EXPIRED);
    });

    it("should detect server errors", () => {
      expect(detectErrorCode({ status: 500 })).toBe(ChannelErrorCode.PROVIDER_ERROR);
      expect(detectErrorCode({ status: 503 })).toBe(ChannelErrorCode.PROVIDER_ERROR);
    });

    it("should return UNKNOWN for unrecognized errors", () => {
      expect(detectErrorCode({})).toBe(ChannelErrorCode.UNKNOWN);
      expect(detectErrorCode(null)).toBe(ChannelErrorCode.UNKNOWN);
    });
  });

  describe("wrapAsChannelError", () => {
    it("should pass through existing ChannelError", () => {
      const original = new ChannelError(ChannelErrorCode.RATE_LIMITED, "test", "id", "ch");

      expect(wrapAsChannelError(original, "new-id", "new-ch")).toBe(original);
    });

    it("should wrap regular Error", () => {
      const original = new Error("Something went wrong");
      const wrapped = wrapAsChannelError(original, "corr-1", "telegram");

      expect(wrapped).toBeInstanceOf(ChannelError);
      expect(wrapped.message).toBe("Something went wrong");
      expect(wrapped.correlationId).toBe("corr-1");
      expect(wrapped.cause).toBe(original);
    });

    it("should wrap string errors", () => {
      const wrapped = wrapAsChannelError("string error", "corr-2", "discord");

      expect(wrapped.message).toBe("string error");
    });
  });
});

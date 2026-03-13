import { describe, expect, it, vi } from "vitest";
import { createTelegramRetryRunner, isRetryableDiscordNetworkError } from "./retry-policy.js";

describe("isRetryableDiscordNetworkError", () => {
  it("returns true for TypeError with 'fetch failed'", () => {
    expect(isRetryableDiscordNetworkError(new TypeError("fetch failed"))).toBe(true);
  });

  it("returns true for error with ECONNRESET code", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isRetryableDiscordNetworkError(err)).toBe(true);
  });

  it("returns true for TypeError with 'fetch failed' even with unknown code", () => {
    const err = Object.assign(new TypeError("fetch failed"), { code: "UNKNOWN_CODE" });
    expect(isRetryableDiscordNetworkError(err)).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isRetryableDiscordNetworkError("fetch failed")).toBe(false);
    expect(isRetryableDiscordNetworkError(null)).toBe(false);
  });

  it("returns false for regular Error without network indicators", () => {
    expect(isRetryableDiscordNetworkError(new Error("bad request"))).toBe(false);
  });
});

describe("createTelegramRetryRunner", () => {
  describe("strictShouldRetry", () => {
    it("without strictShouldRetry: ECONNRESET is retried via regex fallback even when predicate returns false", async () => {
      const fn = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      const runner = createTelegramRetryRunner({
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        shouldRetry: () => false, // predicate says no
        // strictShouldRetry not set — regex fallback still applies
      });
      await expect(runner(fn, "test")).rejects.toThrow("ECONNRESET");
      // Regex matches "reset" so it retried despite shouldRetry returning false
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("with strictShouldRetry=true: ECONNRESET is NOT retried when predicate returns false", async () => {
      const fn = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      const runner = createTelegramRetryRunner({
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        shouldRetry: () => false,
        strictShouldRetry: true, // predicate is authoritative
      });
      await expect(runner(fn, "test")).rejects.toThrow("ECONNRESET");
      // No retry — predicate returned false and regex fallback was suppressed
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("with strictShouldRetry=true: ECONNREFUSED is still retried when predicate returns true", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }))
        .mockResolvedValue("ok");
      const runner = createTelegramRetryRunner({
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        shouldRetry: (err) => (err as { code?: string }).code === "ECONNREFUSED",
        strictShouldRetry: true,
      });
      await expect(runner(fn, "test")).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createTelegramRetryRunner } from "./retry-policy.js";

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

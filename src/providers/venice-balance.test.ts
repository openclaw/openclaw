import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  extractVeniceBalance,
  updateVeniceBalance,
  getVeniceBalance,
  clearVeniceBalance,
  evaluateBalanceStatus,
  evaluateBalanceDetailed,
  formatVeniceBalanceStatus,
  generateBalanceWarning,
  isVeniceBalanceError,
  formatVeniceError,
  isVeniceProvider,
  isVeniceApiUrl,
  onVeniceBalanceUpdate,
  resolveVeniceBalanceThresholds,
  DEFAULT_VENICE_BALANCE_THRESHOLDS,
  type VeniceBalance,
} from "./venice-balance.js";

describe("venice-balance", () => {
  beforeEach(() => {
    clearVeniceBalance();
  });

  afterEach(() => {
    clearVeniceBalance();
  });

  describe("extractVeniceBalance", () => {
    it("extracts balance from Headers object", () => {
      const headers = new Headers();
      headers.set("x-venice-balance-diem", "44.32116826");
      headers.set("x-venice-balance-usd", "10.50");

      const balance = extractVeniceBalance(headers);

      expect(balance).not.toBeNull();
      expect(balance?.diem).toBeCloseTo(44.32116826);
      expect(balance?.usd).toBeCloseTo(10.5);
      expect(balance?.lastChecked).toBeGreaterThan(0);
    });

    it("extracts balance from plain object headers", () => {
      const headers: Record<string, string> = {
        "x-venice-balance-diem": "25.5",
      };

      const balance = extractVeniceBalance(headers);

      expect(balance).not.toBeNull();
      expect(balance?.diem).toBeCloseTo(25.5);
      expect(balance?.usd).toBeUndefined();
    });

    it("returns null when no Venice headers present", () => {
      const headers = new Headers();
      headers.set("content-type", "application/json");

      const balance = extractVeniceBalance(headers);

      expect(balance).toBeNull();
    });

    it("returns null for invalid DIEM value", () => {
      const headers = new Headers();
      headers.set("x-venice-balance-diem", "invalid");

      const balance = extractVeniceBalance(headers);

      expect(balance).toBeNull();
    });

    it("extracts rate limit headers", () => {
      const headers = new Headers();
      headers.set("x-venice-balance-diem", "44.32");
      headers.set("x-ratelimit-limit-requests", "500");
      headers.set("x-ratelimit-remaining-requests", "499");
      headers.set("x-ratelimit-limit-tokens", "5000000");
      headers.set("x-ratelimit-remaining-tokens", "4999000");
      headers.set("x-ratelimit-reset-requests", "1769585280000");

      const balance = extractVeniceBalance(headers);

      expect(balance).not.toBeNull();
      expect(balance?.rateLimit).toBeDefined();
      expect(balance?.rateLimit?.limitRequests).toBe(500);
      expect(balance?.rateLimit?.remainingRequests).toBe(499);
      expect(balance?.rateLimit?.limitTokens).toBe(5000000);
      expect(balance?.rateLimit?.remainingTokens).toBe(4999000);
      expect(balance?.rateLimit?.resetAt).toBe(1769585280000);
    });
  });

  describe("updateVeniceBalance / getVeniceBalance", () => {
    it("stores and retrieves balance", () => {
      const balance: VeniceBalance = {
        diem: 50,
        usd: 20,
        lastChecked: Date.now(),
      };

      updateVeniceBalance(balance);

      const retrieved = getVeniceBalance();
      expect(retrieved).toEqual(balance);
    });

    it("clearVeniceBalance clears stored balance", () => {
      updateVeniceBalance({ diem: 50, lastChecked: Date.now() });

      clearVeniceBalance();

      expect(getVeniceBalance()).toBeNull();
    });
  });

  describe("evaluateBalanceStatus", () => {
    it("returns 'ok' for balance above low threshold", () => {
      const balance: VeniceBalance = { diem: 50, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(balance)).toBe("ok");
    });

    it("returns 'low' for balance below low threshold (5 DIEM)", () => {
      const balance: VeniceBalance = { diem: 4, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(balance)).toBe("low");
    });

    it("returns 'critical' for balance below critical threshold (2 DIEM)", () => {
      const balance: VeniceBalance = { diem: 1, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(balance)).toBe("critical");
    });

    it("returns 'depleted' for zero balance", () => {
      const balance: VeniceBalance = { diem: 0, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(balance)).toBe("depleted");
    });

    it("returns 'unknown' for null balance", () => {
      expect(evaluateBalanceStatus(null)).toBe("unknown");
    });

    it("respects custom thresholds", () => {
      const balance: VeniceBalance = { diem: 15, lastChecked: Date.now() };
      const customThresholds = {
        ...DEFAULT_VENICE_BALANCE_THRESHOLDS,
        lowDiemThreshold: 20,
      };
      expect(evaluateBalanceStatus(balance, customThresholds)).toBe("low");
    });
  });

  describe("evaluateBalanceDetailed - rate limits", () => {
    it("returns critical when request limit is nearly exhausted", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitRequests: 500,
          remainingRequests: 10, // 2% remaining, below 5% critical threshold
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("critical");
      expect(evaluation.reason).toBe("rate_limit");
    });

    it("returns low when request limit is getting low", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitRequests: 500,
          remainingRequests: 40, // 8% remaining, below 10% low threshold
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("low");
      expect(evaluation.reason).toBe("rate_limit");
    });

    it("returns depleted when request limit is exhausted", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitRequests: 500,
          remainingRequests: 0,
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("depleted");
      expect(evaluation.reason).toBe("rate_limit");
    });

    it("DIEM takes priority over rate limit for depleted status", () => {
      const balance: VeniceBalance = {
        diem: 0,
        lastChecked: Date.now(),
        rateLimit: {
          limitRequests: 500,
          remainingRequests: 500, // plenty of requests
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("depleted");
      expect(evaluation.reason).toBe("diem");
    });

    it("returns ok when both DIEM and rate limits are healthy", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitRequests: 500,
          remainingRequests: 400, // 80% remaining
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("ok");
    });
  });

  describe("formatVeniceBalanceStatus", () => {
    it("returns formatted status for OK balance", () => {
      const balance: VeniceBalance = { diem: 50, lastChecked: Date.now() };
      const result = formatVeniceBalanceStatus(balance);

      expect(result).toContain("DIEM: 50.00");
      expect(result).toContain("✅ OK");
    });

    it("returns formatted status with USD when present", () => {
      const balance: VeniceBalance = { diem: 50, usd: 10.5, lastChecked: Date.now() };
      const result = formatVeniceBalanceStatus(balance);

      expect(result).toContain("USD: $10.50");
    });

    it("returns null when showInStatus is false", () => {
      const balance: VeniceBalance = { diem: 50, lastChecked: Date.now() };
      const thresholds = { ...DEFAULT_VENICE_BALANCE_THRESHOLDS, showInStatus: false };

      expect(formatVeniceBalanceStatus(balance, thresholds)).toBeNull();
    });

    it("returns null for null balance", () => {
      expect(formatVeniceBalanceStatus(null)).toBeNull();
    });
  });

  describe("generateBalanceWarning", () => {
    it("returns null for OK balance", () => {
      const balance: VeniceBalance = { diem: 50, lastChecked: Date.now() };
      expect(generateBalanceWarning(balance)).toBeNull();
    });

    it("returns warning for low DIEM balance", () => {
      const balance: VeniceBalance = { diem: 4, lastChecked: Date.now() };
      const warning = generateBalanceWarning(balance);

      expect(warning).toContain("⚠️");
      expect(warning).toContain("low");
      expect(warning).toContain("4.00");
    });

    it("returns critical warning for critical DIEM balance", () => {
      const balance: VeniceBalance = { diem: 1, lastChecked: Date.now() };
      const warning = generateBalanceWarning(balance);

      expect(warning).toContain("🚨");
      expect(warning).toContain("critical");
    });

    it("returns depleted warning for zero DIEM balance", () => {
      const balance: VeniceBalance = { diem: 0, lastChecked: Date.now() };
      const warning = generateBalanceWarning(balance);

      expect(warning).toContain("❌");
      expect(warning).toContain("depleted");
    });

    it("returns null when warnings disabled", () => {
      const balance: VeniceBalance = { diem: 1, lastChecked: Date.now() };
      const thresholds = { ...DEFAULT_VENICE_BALANCE_THRESHOLDS, enabled: false };

      expect(generateBalanceWarning(balance, thresholds)).toBeNull();
    });

    it("returns warning for low rate limit", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitRequests: 500,
          remainingRequests: 40, // 8% remaining
        },
      };
      const warning = generateBalanceWarning(balance);

      expect(warning).toContain("⚠️");
      expect(warning).toContain("API key limit");
    });

    it("returns critical warning for exhausted rate limit", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitRequests: 500,
          remainingRequests: 0,
        },
      };
      const warning = generateBalanceWarning(balance);

      expect(warning).toContain("❌");
      expect(warning).toContain("limit reached");
    });
  });

  describe("isVeniceBalanceError", () => {
    it("detects insufficient balance error", () => {
      expect(isVeniceBalanceError("insufficient balance")).toBe(true);
      expect(isVeniceBalanceError("Error: insufficient_balance")).toBe(true);
    });

    it("detects spending cap error", () => {
      expect(isVeniceBalanceError("spending_cap_exceeded")).toBe(true);
      expect(isVeniceBalanceError("Spending cap reached")).toBe(true);
    });

    it("returns false for non-balance errors", () => {
      expect(isVeniceBalanceError("rate limit exceeded")).toBe(false);
      expect(isVeniceBalanceError("connection timeout")).toBe(false);
    });
  });

  describe("formatVeniceError", () => {
    it("formats insufficient balance error", () => {
      const result = formatVeniceError("insufficient balance");

      expect(result).toContain("Insufficient balance");
      expect(result).toContain("https://venice.ai/settings/billing");
    });

    it("formats spending cap error", () => {
      const result = formatVeniceError("spending_cap_exceeded");

      expect(result).toContain("spending cap");
      expect(result).toContain("API key");
    });

    it("returns original message for non-Venice errors", () => {
      const original = "Generic error message";
      expect(formatVeniceError(original)).toBe(original);
    });
  });

  describe("isVeniceProvider", () => {
    it("returns true for venice provider", () => {
      expect(isVeniceProvider("venice")).toBe(true);
      expect(isVeniceProvider("Venice")).toBe(true);
      expect(isVeniceProvider("VENICE")).toBe(true);
    });

    it("returns true for venice/ prefixed provider", () => {
      expect(isVeniceProvider("venice/llama-3.3-70b")).toBe(true);
    });

    it("returns false for other providers", () => {
      expect(isVeniceProvider("openai")).toBe(false);
      expect(isVeniceProvider("anthropic")).toBe(false);
    });
  });

  describe("isVeniceApiUrl", () => {
    it("returns true for Venice API URLs", () => {
      expect(isVeniceApiUrl("https://api.venice.ai/api/v1/chat")).toBe(true);
      expect(isVeniceApiUrl(new URL("https://api.venice.ai/v1/models"))).toBe(true);
    });

    it("returns false for non-Venice URLs", () => {
      expect(isVeniceApiUrl("https://api.openai.com/v1/chat")).toBe(false);
    });

    it("handles invalid URLs gracefully", () => {
      expect(isVeniceApiUrl("not-a-url")).toBe(false);
    });
  });

  describe("onVeniceBalanceUpdate", () => {
    it("calls callback when balance is updated", () => {
      const callback = vi.fn();
      const unsubscribe = onVeniceBalanceUpdate(callback);

      const balance: VeniceBalance = { diem: 50, lastChecked: Date.now() };
      updateVeniceBalance(balance);

      expect(callback).toHaveBeenCalledWith(balance);
      unsubscribe();
    });

    it("unsubscribe stops further callbacks", () => {
      const callback = vi.fn();
      const unsubscribe = onVeniceBalanceUpdate(callback);

      updateVeniceBalance({ diem: 50, lastChecked: Date.now() });
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      updateVeniceBalance({ diem: 40, lastChecked: Date.now() });
      expect(callback).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    it("handles callback errors gracefully", () => {
      const errorCallback = vi.fn(() => {
        throw new Error("Callback error");
      });
      const goodCallback = vi.fn();

      const unsub1 = onVeniceBalanceUpdate(errorCallback);
      const unsub2 = onVeniceBalanceUpdate(goodCallback);

      // Should not throw, and good callback should still be called
      expect(() => updateVeniceBalance({ diem: 50, lastChecked: Date.now() })).not.toThrow();
      expect(goodCallback).toHaveBeenCalled();

      unsub1();
      unsub2();
    });
  });

  describe("resolveVeniceBalanceThresholds", () => {
    it("returns defaults when no config provided", () => {
      expect(resolveVeniceBalanceThresholds()).toEqual(DEFAULT_VENICE_BALANCE_THRESHOLDS);
      expect(resolveVeniceBalanceThresholds({})).toEqual(DEFAULT_VENICE_BALANCE_THRESHOLDS);
      expect(resolveVeniceBalanceThresholds({ models: {} })).toEqual(DEFAULT_VENICE_BALANCE_THRESHOLDS);
    });

    it("merges partial config with defaults", () => {
      const config = {
        models: {
          veniceBalanceWarning: {
            lowDiemThreshold: 10,
            enabled: false,
          },
        },
      };
      const result = resolveVeniceBalanceThresholds(config);

      expect(result.lowDiemThreshold).toBe(10);
      expect(result.enabled).toBe(false);
      // Other values should be defaults
      expect(result.criticalDiemThreshold).toBe(DEFAULT_VENICE_BALANCE_THRESHOLDS.criticalDiemThreshold);
      expect(result.showInStatus).toBe(DEFAULT_VENICE_BALANCE_THRESHOLDS.showInStatus);
    });
  });

  describe("evaluateBalanceDetailed - token limits", () => {
    it("returns critical when token limit is nearly exhausted", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitTokens: 1000000,
          remainingTokens: 20000, // 2% remaining
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("critical");
      expect(evaluation.reason).toBe("rate_limit");
    });

    it("returns low when token limit is getting low", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitTokens: 1000000,
          remainingTokens: 80000, // 8% remaining
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("low");
      expect(evaluation.reason).toBe("rate_limit");
    });

    it("returns depleted when token limit is exhausted", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitTokens: 1000000,
          remainingTokens: 0,
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("depleted");
      expect(evaluation.reason).toBe("rate_limit");
    });
  });

  describe("edge cases", () => {
    it("handles negative DIEM balance as depleted", () => {
      const balance: VeniceBalance = { diem: -5, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(balance)).toBe("depleted");
    });

    it("handles negative remaining requests as depleted", () => {
      const balance: VeniceBalance = {
        diem: 50,
        lastChecked: Date.now(),
        rateLimit: {
          limitRequests: 500,
          remainingRequests: -10, // Over-limit
        },
      };
      const evaluation = evaluateBalanceDetailed(balance);
      expect(evaluation.status).toBe("depleted");
      expect(evaluation.reason).toBe("rate_limit");
    });

    it("extracts balance from case-insensitive plain object headers", () => {
      const headers: Record<string, string> = {
        "X-Venice-Balance-Diem": "25.5", // Mixed case
      };
      const balance = extractVeniceBalance(headers);
      expect(balance).not.toBeNull();
      expect(balance?.diem).toBeCloseTo(25.5);
    });

    it("handles balance at exact threshold boundaries", () => {
      // At exactly 5 DIEM (low threshold) - should be low, not ok
      const atLow: VeniceBalance = { diem: 5, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(atLow)).toBe("ok"); // 5 is NOT below 5

      // Just below 5 DIEM
      const belowLow: VeniceBalance = { diem: 4.99, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(belowLow)).toBe("low");

      // At exactly 2 DIEM (critical threshold)
      const atCritical: VeniceBalance = { diem: 2, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(atCritical)).toBe("low"); // 2 is NOT below 2

      // Just below 2 DIEM
      const belowCritical: VeniceBalance = { diem: 1.99, lastChecked: Date.now() };
      expect(evaluateBalanceStatus(belowCritical)).toBe("critical");
    });
  });
});

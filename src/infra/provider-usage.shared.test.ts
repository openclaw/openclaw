import { describe, expect, it } from "vitest";
import {
  resolveUsageProviderId,
  clampPercent,
  withTimeout,
  usageProviders,
  PROVIDER_LABELS,
  ignoredErrors,
} from "./provider-usage.shared.js";

describe("resolveUsageProviderId", () => {
  it("returns undefined for null/undefined/empty", () => {
    expect(resolveUsageProviderId(null)).toBeUndefined();
    expect(resolveUsageProviderId(undefined)).toBeUndefined();
    expect(resolveUsageProviderId("")).toBeUndefined();
  });

  it("resolves known provider IDs", () => {
    expect(resolveUsageProviderId("anthropic")).toBe("anthropic");
  });

  it("returns undefined for unknown providers", () => {
    expect(resolveUsageProviderId("unknown-provider")).toBeUndefined();
  });
});

describe("clampPercent", () => {
  it("returns value in range", () => {
    expect(clampPercent(50)).toBe(50);
  });

  it("clamps below 0", () => {
    expect(clampPercent(-10)).toBe(0);
  });

  it("clamps above 100", () => {
    expect(clampPercent(150)).toBe(100);
  });

  it("handles non-finite values as 0", () => {
    expect(clampPercent(NaN)).toBe(0);
    expect(clampPercent(Infinity)).toBe(0);
    expect(clampPercent(-Infinity)).toBe(0);
  });

  it("handles edge values", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(100)).toBe(100);
  });
});

describe("withTimeout", () => {
  it("returns work result when fast", async () => {
    const result = await withTimeout(Promise.resolve("done"), 1000, "fallback");
    expect(result).toBe("done");
  });

  it("returns fallback on timeout", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 5000));
    const result = await withTimeout(slow, 10, "fallback");
    expect(result).toBe("fallback");
  });
});

describe("constants", () => {
  it("usageProviders has all labeled providers", () => {
    for (const id of usageProviders) {
      expect(PROVIDER_LABELS[id]).toBeDefined();
    }
  });

  it("ignoredErrors is a set of strings", () => {
    expect(ignoredErrors.has("No credentials")).toBe(true);
    expect(ignoredErrors.has("random")).toBe(false);
  });
});

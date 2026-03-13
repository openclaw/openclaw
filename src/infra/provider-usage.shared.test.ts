import { describe, expect, it } from "vitest";
import { clampPercent, resolveUsageProviderId, withTimeout } from "./provider-usage.shared.js";

describe("provider-usage.shared", () => {
  it.each([
    { value: "z-ai", expected: "zai" },
    { value: " GOOGLE-GEMINI-CLI ", expected: "google-gemini-cli" },
    { value: "unknown-provider", expected: undefined },
    { value: undefined, expected: undefined },
    { value: null, expected: undefined },
  ])("normalizes provider ids for %j", ({ value, expected }) => {
    expect(resolveUsageProviderId(value)).toBe(expected);
  });

  it.each([
    { value: -5, expected: 0 },
    { value: 42, expected: 42 },
    { value: 120, expected: 100 },
    { value: Number.NaN, expected: 0 },
    { value: Number.POSITIVE_INFINITY, expected: 0 },
  ])("clamps usage percents for %j", ({ value, expected }) => {
    expect(clampPercent(value)).toBe(expected);
  });

  it("returns work result when it resolves before timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "fallback")).resolves.toBe("ok");
  });

  it("propagates work errors before timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 100, "fallback")).rejects.toThrow(
      "boom",
    );
  });

  it("returns fallback when timeout wins", async () => {
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 50));
    await expect(withTimeout(late, 1, "fallback")).resolves.toBe("fallback");
  });
});

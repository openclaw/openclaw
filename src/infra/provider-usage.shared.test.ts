import { describe, expect, test } from "vitest";
import { withTimeout } from "./provider-usage.shared.js";

describe("withTimeout", () => {
  test("returns work result when it resolves before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "fallback");
    expect(result).toBe("ok");
  });

  test("returns fallback when work times out", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 5000));
    const result = await withTimeout(slow, 50, "fallback");
    expect(result).toBe("fallback");
  });

  test("returns fallback when work rejects (network error)", async () => {
    const failing = Promise.reject(new TypeError("fetch failed"));
    const result = await withTimeout(failing, 1000, "fallback");
    expect(result).toBe("fallback");
  });

  test("returns fallback when work rejects with generic error", async () => {
    const failing = Promise.reject(new Error("connection refused"));
    const result = await withTimeout(failing, 1000, "fallback");
    expect(result).toBe("fallback");
  });

  test("returns fallback object when work rejects", async () => {
    const fallback = { provider: "test", windows: [], error: "Timeout" };
    const failing = Promise.reject(new TypeError("fetch failed"));
    const result = await withTimeout(failing, 1000, fallback);
    expect(result).toEqual(fallback);
  });
});

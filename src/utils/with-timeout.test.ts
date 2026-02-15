import { describe, expect, it } from "vitest";

import { withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  it("rejects when promise times out", async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 100));
    await expect(withTimeout(slow, 10)).rejects.toThrow(/Timed out after 10ms/);
  });

  it("uses custom error message when provided", async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 100));
    await expect(withTimeout(slow, 10, "Custom timeout")).rejects.toThrow("Custom timeout");
  });

  it("returns promise directly when timeoutMs is 0", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 0);
    expect(result).toBe("ok");
  });

  it("returns promise directly when timeoutMs is negative", async () => {
    const result = await withTimeout(Promise.resolve("ok"), -1);
    expect(result).toBe("ok");
  });

  it("clears timer when promise resolves", async () => {
    const start = Date.now();
    await withTimeout(Promise.resolve("ok"), 5000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("propagates rejection from original promise", async () => {
    const failing = Promise.reject(new Error("original error"));
    await expect(withTimeout(failing, 1000)).rejects.toThrow("original error");
  });
});

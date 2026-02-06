import { describe, expect, it } from "vitest";
import { withTimeout } from "./provider-usage.shared.js";

describe("withTimeout", () => {
  it("returns fallback when AbortError is thrown", async () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";

    const result = await withTimeout(
      Promise.reject(abortError),
      1000,
      { error: "Timeout" },
    );

    expect(result).toEqual({ error: "Timeout" });
  });

  it("returns fallback when undici AbortError is thrown", async () => {
    // Simulates the undici-style AbortError from the bug report
    const abortError = new Error("This operation was aborted");

    const result = await withTimeout(
      Promise.reject(abortError),
      1000,
      { error: "Timeout" },
    );

    expect(result).toEqual({ error: "Timeout" });
  });

  it("rethrows non-AbortError errors", async () => {
    const error = new Error("Network error");

    await expect(
      withTimeout(Promise.reject(error), 1000, { error: "Timeout" }),
    ).rejects.toThrow("Network error");
  });

  it("resolves successfully when work completes before timeout", async () => {
    const result = await withTimeout(
      Promise.resolve({ success: true }),
      10000,
      { error: "Timeout" },
    );

    expect(result).toEqual({ success: true });
  });
});

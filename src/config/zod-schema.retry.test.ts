// `perCallTimeoutMs` is exposed through the public retry config contract so
// callers can declare a per-attempt timeout cap globally or per-channel in
// `openclaw.json`. This keeps the contract aligned with the internal
// `RetryConfig` shape consumed by `retryAsync` / channel retry runners.

import { describe, expect, it } from "vitest";
import { RetryConfigSchema } from "./zod-schema.core.js";

describe("RetryConfigSchema perCallTimeoutMs", () => {
  it("accepts a positive integer perCallTimeoutMs", () => {
    const result = RetryConfigSchema.safeParse({
      attempts: 3,
      perCallTimeoutMs: 25_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.perCallTimeoutMs).toBe(25_000);
    }
  });

  it("accepts zero to mean disabled", () => {
    const result = RetryConfigSchema.safeParse({ perCallTimeoutMs: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.perCallTimeoutMs).toBe(0);
    }
  });

  it("treats perCallTimeoutMs as optional", () => {
    const result = RetryConfigSchema.safeParse({ attempts: 3 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.perCallTimeoutMs).toBeUndefined();
    }
  });

  it("rejects negative perCallTimeoutMs", () => {
    const result = RetryConfigSchema.safeParse({ perCallTimeoutMs: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer perCallTimeoutMs", () => {
    const result = RetryConfigSchema.safeParse({ perCallTimeoutMs: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects non-number perCallTimeoutMs", () => {
    const result = RetryConfigSchema.safeParse({ perCallTimeoutMs: "30000" });
    expect(result.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { resolveCacheTtlMs } from "./cache-utils.js";

describe("resolveCacheTtlMs", () => {
  it("accepts exact non-negative integers", () => {
    expect(resolveCacheTtlMs({ envValue: "0", defaultTtlMs: 60_000 })).toBe(0);
    expect(resolveCacheTtlMs({ envValue: "120000", defaultTtlMs: 60_000 })).toBe(120_000);
  });

  it("rejects malformed env values and falls back to the default", () => {
    expect(resolveCacheTtlMs({ envValue: "0abc", defaultTtlMs: 60_000 })).toBe(60_000);
    expect(resolveCacheTtlMs({ envValue: "15ms", defaultTtlMs: 60_000 })).toBe(60_000);
  });
});

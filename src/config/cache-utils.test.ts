import { describe, expect, it } from "vitest";
import { resolveCacheTtlMs, isCacheEnabled } from "./cache-utils.js";

describe("resolveCacheTtlMs", () => {
  it("returns default when envValue is undefined", () => {
    expect(resolveCacheTtlMs({ envValue: undefined, defaultTtlMs: 5000 })).toBe(5000);
  });

  it("returns default when envValue is empty string", () => {
    expect(resolveCacheTtlMs({ envValue: "", defaultTtlMs: 5000 })).toBe(5000);
  });

  it("parses valid numeric envValue", () => {
    expect(resolveCacheTtlMs({ envValue: "10000", defaultTtlMs: 5000 })).toBe(10000);
  });

  it("returns 0 when envValue is '0' (cache disabled)", () => {
    expect(resolveCacheTtlMs({ envValue: "0", defaultTtlMs: 5000 })).toBe(0);
  });

  it("returns default for non-numeric envValue", () => {
    expect(resolveCacheTtlMs({ envValue: "abc", defaultTtlMs: 5000 })).toBe(5000);
  });

  it("returns default for negative envValue", () => {
    expect(resolveCacheTtlMs({ envValue: "-1", defaultTtlMs: 5000 })).toBe(5000);
  });

  it("handles large values", () => {
    expect(resolveCacheTtlMs({ envValue: "86400000", defaultTtlMs: 5000 })).toBe(86400000);
  });
});

describe("isCacheEnabled", () => {
  it("returns true for positive TTL", () => {
    expect(isCacheEnabled(5000)).toBe(true);
    expect(isCacheEnabled(1)).toBe(true);
  });

  it("returns false for zero TTL", () => {
    expect(isCacheEnabled(0)).toBe(false);
  });

  it("returns false for negative TTL", () => {
    expect(isCacheEnabled(-1)).toBe(false);
  });
});

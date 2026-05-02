import { describe, expect, it } from "vitest";
import {
  COMPLETION_CACHE_WRITE_TIMEOUT_ENV,
  resolveCompletionCacheWriteTimeoutMs,
} from "./completion-runtime.js";

describe("resolveCompletionCacheWriteTimeoutMs", () => {
  it("returns the 30000ms default when the env var is unset", () => {
    expect(resolveCompletionCacheWriteTimeoutMs({})).toBe(30_000);
  });

  it("returns the default when the env var is an empty string", () => {
    expect(resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "" })).toBe(
      30_000,
    );
  });

  it("returns the default when the env var is whitespace only", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "   " }),
    ).toBe(30_000);
  });

  it("returns the default when the env var is non-numeric", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "soon" }),
    ).toBe(30_000);
  });

  it("returns the default when the env var is zero", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "0" }),
    ).toBe(30_000);
  });

  it("returns the default when the env var is negative", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "-100" }),
    ).toBe(30_000);
  });

  it("returns the parsed value when the env var is a positive integer", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "60000" }),
    ).toBe(60_000);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({
        [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "  120000  ",
      }),
    ).toBe(120_000);
  });

  // Strict-parser regression coverage — the env var must accept only positive
  // integer milliseconds. parseInt would silently truncate the inputs below
  // (e.g. "60_000" → 60, "1e5" → 1), which would surprise operators expecting
  // their literal value to be honored.
  it.each([
    ["numeric separator", "60_000"],
    ["exponent notation", "1e5"],
    ["fractional value", "1.5"],
    ["trailing garbage", "30000abc"],
    ["leading whitespace inside number", "30 000"],
    ["leading zero", "030000"],
    ["plus sign prefix", "+60000"],
    ["hex prefix", "0x7530"],
  ])("falls back to the default when the env var has %s (%s)", (_label, value) => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: value }),
    ).toBe(30_000);
  });

  it("falls back when the env var exceeds Number.MAX_SAFE_INTEGER", () => {
    const tooLarge = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: tooLarge }),
    ).toBe(30_000);
  });
});

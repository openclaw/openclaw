/**
 * Gateway hook server tests — sanitizeHookConsoleValue and related utilities.
 */
import { describe, expect, it } from "vitest";
import { sanitizeHookConsoleValue } from "./hooks.js";

describe("sanitizeHookConsoleValue", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeHookConsoleValue(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(sanitizeHookConsoleValue("")).toBeUndefined();
  });

  it("trims whitespace and replaces control characters", () => {
    const result = sanitizeHookConsoleValue("  hello\x00world\t");
    expect(result).toBe("hello world");
  });

  it("preserves values under the limit", () => {
    const input = "a".repeat(400);
    expect(sanitizeHookConsoleValue(input)).toBe(input);
  });

  it("truncates values at 500 chars", () => {
    const input = "a".repeat(600);
    const result = sanitizeHookConsoleValue(input);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(500);
  });

  it("keeps truncated value UTF-16 safe at the truncation boundary", () => {
    const prefix = "a".repeat(499);
    const input = `${prefix}\u{1F600}trailing`;
    const result = sanitizeHookConsoleValue(input);
    expect(result).toBeDefined();
    // The emoji (surrogate pair) should not appear broken
    expect(result).not.toContain("\u{1F600}");
  });
});

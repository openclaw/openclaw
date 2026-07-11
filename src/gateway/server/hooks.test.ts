/**
 * Gateway hook server helper tests.
 */
import { describe, expect, test } from "vitest";
import { sanitizeHookConsoleValue } from "./hooks.js";

describe("sanitizeHookConsoleValue", () => {
  test("returns undefined for undefined or empty input", () => {
    expect(sanitizeHookConsoleValue(undefined)).toBeUndefined();
    expect(sanitizeHookConsoleValue("")).toBeUndefined();
    expect(sanitizeHookConsoleValue("   ")).toBeUndefined();
  });

  test("replaces control characters with spaces", () => {
    expect(sanitizeHookConsoleValue("hello\tworld\x7F")).toBe("hello world");
  });

  test("collapses whitespace and trims", () => {
    expect(sanitizeHookConsoleValue("  hello   world  ")).toBe("hello world");
  });

  test("truncates long ASCII to 500 chars", () => {
    const input = "a".repeat(600);
    expect(sanitizeHookConsoleValue(input)).toBe("a".repeat(500));
  });

  test("does not split a surrogate pair at the 500-code-unit boundary", () => {
    const input = `${"a".repeat(499)}😀${"b".repeat(10)}`;
    const output = sanitizeHookConsoleValue(input);
    expect(output).toBe("a".repeat(499));
    expect(output?.isWellFormed()).toBe(true);
  });

  test("preserves a complete surrogate pair when it fits", () => {
    const input = `${"a".repeat(498)}😀${"b".repeat(10)}`;
    const output = sanitizeHookConsoleValue(input);
    expect(output).toBe(`${"a".repeat(498)}😀`);
    expect(output?.isWellFormed()).toBe(true);
  });
});

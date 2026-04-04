import { describe, expect, it } from "vitest";
import { coerceIdentityValue } from "./assistant-identity-values.js";

describe("coerceIdentityValue", () => {
  it("returns undefined for non-string input", () => {
    expect(coerceIdentityValue(123 as any, 50)).toBeUndefined();
    expect(coerceIdentityValue(null, 50)).toBeUndefined();
    expect(coerceIdentityValue(undefined, 50)).toBeUndefined();
  });

  it("returns undefined for empty or whitespace-only strings", () => {
    expect(coerceIdentityValue("", 50)).toBeUndefined();
    expect(coerceIdentityValue("   ", 50)).toBeUndefined();
  });

  it("returns trimmed value within maxLength", () => {
    expect(coerceIdentityValue("  hello  ", 50)).toBe("hello");
    expect(coerceIdentityValue("test", 10)).toBe("test");
  });

  it("truncates values exceeding maxLength", () => {
    const long = "a".repeat(100);
    const result = coerceIdentityValue(long, 50);
    expect(result?.length).toBe(50);
    expect(result).toBe(long.slice(0, 50));
  });

  it("handles exact boundary length", () => {
    expect(coerceIdentityValue("abc", 3)).toBe("abc");
    expect(coerceIdentityValue("abcd", 3)).toBe("abc");
  });

  it("handles maxLength of 0", () => {
    expect(coerceIdentityValue("test", 0)).toBe("");
  });
});

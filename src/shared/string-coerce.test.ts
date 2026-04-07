import { describe, expect, it } from "vitest";
import { sanitizeModelName } from "./string-coerce.js";

describe("sanitizeModelName", () => {
  it("returns undefined for empty / missing values", () => {
    expect(sanitizeModelName(undefined)).toBeUndefined();
    expect(sanitizeModelName(null)).toBeUndefined();
    expect(sanitizeModelName("")).toBeUndefined();
    expect(sanitizeModelName("   ")).toBeUndefined();
  });

  it("passes through already-valid names unchanged", () => {
    expect(sanitizeModelName("alice")).toBe("alice");
    expect(sanitizeModelName("john_doe")).toBe("john_doe");
    expect(sanitizeModelName("alice-bob")).toBe("alice-bob");
    expect(sanitizeModelName("User123")).toBe("User123");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeModelName("John Doe")).toBe("John_Doe");
    expect(sanitizeModelName("  John  Doe  ")).toBe("John__Doe");
  });

  it("replaces non-ASCII characters with underscores", () => {
    expect(sanitizeModelName("José García")).toBe("Jos__Garc_a");
    expect(sanitizeModelName("François")).toBe("Fran_ois");
  });

  it("replaces CJK characters with underscores", () => {
    expect(sanitizeModelName("王小明")).toBe("___");
  });

  it("replaces emoji with underscores", () => {
    expect(sanitizeModelName("Alex 🚀")).toBe("Alex___");
  });

  it("replaces special punctuation with underscores", () => {
    expect(sanitizeModelName("O'Brien")).toBe("O_Brien");
    expect(sanitizeModelName("user@name")).toBe("user_name");
    expect(sanitizeModelName("a.b.c")).toBe("a_b_c");
  });

  it("truncates to 64 characters", () => {
    const long = "a".repeat(100);
    const result = sanitizeModelName(long);
    expect(result).toHaveLength(64);
    expect(result).toBe("a".repeat(64));
  });

  it("returns undefined when sanitized result is empty", () => {
    // All characters removed → only underscores, but still truthy
    expect(sanitizeModelName("🎉")).toBe("__");
    // Non-string input
    expect(sanitizeModelName(42)).toBeUndefined();
  });
});

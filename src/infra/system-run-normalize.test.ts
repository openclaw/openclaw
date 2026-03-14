import { describe, expect, it } from "vitest";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";

describe("system run normalization helpers", () => {
  it("normalizes only non-empty trimmed strings", () => {
    expect(normalizeNonEmptyString("  hello  ")).toBe("hello");
    expect(normalizeNonEmptyString(" \n\t ")).toBeNull();
    expect(normalizeNonEmptyString(42)).toBeNull();
    expect(normalizeNonEmptyString(null)).toBeNull();
  });

  it("normalizes array entries and rejects non-arrays", () => {
    expect(normalizeStringArray([" alpha ", 42, false])).toEqual([" alpha ", "42", "false"]);
    expect(normalizeStringArray(undefined)).toEqual([]);
    expect(normalizeStringArray("alpha")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  summarizeAllowedValues,
  appendAllowedValuesHint,
} from "./allowed-values.js";

describe("summarizeAllowedValues", () => {
  it("returns null for empty array", () => {
    expect(summarizeAllowedValues([])).toBeNull();
  });

  it("returns single value", () => {
    const result = summarizeAllowedValues(["openai"]);
    expect(result?.values).toEqual(["openai"]);
    expect(result?.hiddenCount).toBe(0);
    expect(result?.formatted).toBe('"openai"');
  });

  it("deduplicates values", () => {
    const result = summarizeAllowedValues(["a", "a", "b"] as any);
    expect(result?.values).toHaveLength(2);
  });

  it("limits to MAX_ALLOWED_VALUES_HINT (12)", () => {
    const values = Array.from({ length: 20 }, (_, i) => `val${i}`);
    const result = summarizeAllowedValues(values as any);
    expect(result?.values).toHaveLength(12);
    expect(result?.hiddenCount).toBe(8);
    expect(result?.formatted).toContain("... (+8 more)");
  });

  it("handles non-string values", () => {
    const result = summarizeAllowedValues([1, 2, true] as any);
    expect(result?.values).toHaveLength(3);
    expect(result?.formatted).toContain("1");
  });

  it("truncates long strings", () => {
    const long = "a".repeat(200);
    const result = summarizeAllowedValues([long]);
    expect(result?.formatted).toContain("... (+");
  });
});

describe("appendAllowedValuesHint", () => {
  it("appends hint to message", () => {
    const summary = { values: [], hiddenCount: 0, formatted: '"a", "b"' };
    expect(appendAllowedValuesHint("invalid", summary)).toBe('invalid (allowed: "a", "b")');
  });

  it("does not append if message already has hint", () => {
    const summary = { values: [], hiddenCount: 0, formatted: '"a"' };
    expect(appendAllowedValuesHint("invalid (allowed: ...)", summary)).toBe("invalid (allowed: ...)");
    expect(appendAllowedValuesHint("expected one of: a", summary)).toBe("expected one of: a");
  });
});

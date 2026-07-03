// Human-readable list formatting tests cover formatHumanList branch coverage.
import { describe, expect, it } from "vitest";
import { formatHumanList } from "./human-list.js";

describe("shared/human-list", () => {
  it("returns an empty string for an empty list", () => {
    expect(formatHumanList([])).toBe("");
  });

  it("returns the single item as-is", () => {
    expect(formatHumanList(["apple"])).toBe("apple");
  });

  it("joins two items with ' or '", () => {
    expect(formatHumanList(["apple", "banana"])).toBe("apple or banana");
  });

  it("formats three items as 'A, B, or C'", () => {
    expect(formatHumanList(["apple", "banana", "cherry"])).toBe("apple, banana, or cherry");
  });

  it("formats four items with correct serial comma", () => {
    expect(formatHumanList(["apple", "banana", "cherry", "date"])).toBe(
      "apple, banana, cherry, or date",
    );
  });

  it("preserves special characters in items", () => {
    expect(formatHumanList(["co-op", "it's", "rock&roll"])).toBe("co-op, it's, or rock&roll");
  });

  it("does not confuse embedded 'or' in item text", () => {
    expect(formatHumanList(["this or that", "something else"])).toBe(
      "this or that or something else",
    );
  });

  it("preserves whitespace in items", () => {
    expect(formatHumanList(["  spaced  ", "trimmed"])).toBe("  spaced   or trimmed");
  });

  it("accepts a readonly tuple input", () => {
    const items = ["a", "b", "c"] as const;
    expect(formatHumanList(items)).toBe("a, b, or c");
  });

  it("returns the first item for a single-item readonly tuple", () => {
    const items = ["only"] as const;
    expect(formatHumanList(items)).toBe("only");
  });

  it("handles empty strings as items", () => {
    expect(formatHumanList(["", ""])).toBe(" or ");
  });

  it("handles very long items without truncation", () => {
    const long = "x".repeat(1000);
    expect(formatHumanList([long, "y"])).toBe(`${long} or y`);
    expect(formatHumanList(["a", "b", long])).toBe(`a, b, or ${long}`);
  });
});

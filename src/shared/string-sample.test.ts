import { describe, expect, it } from "vitest";
import { summarizeStringEntries } from "./string-sample.js";

describe("summarizeStringEntries", () => {
  it("returns emptyText for empty lists", () => {
    expect(summarizeStringEntries({ entries: [], emptyText: "any" })).toBe("any");
    expect(summarizeStringEntries({ entries: null })).toBe("");
  });

  it("uses the default limit when none is provided", () => {
    expect(summarizeStringEntries({ entries: ["a", "b", "c", "d", "e", "f", "g"] })).toBe(
      "a, b, c, d, e, f (+1)",
    );
  });

  it("uses the default limit for non-finite limits", () => {
    expect(
      summarizeStringEntries({
        entries: ["a", "b", "c", "d", "e", "f", "g"],
        limit: Number.NaN,
      }),
    ).toBe("a, b, c, d, e, f (+1)");
  });

  it("does not add a suffix when the limit exactly matches the entry count", () => {
    expect(
      summarizeStringEntries({ entries: ["a", "b", "c"], limit: 3, emptyText: "ignored" }),
    ).toBe("a, b, c");
  });
});

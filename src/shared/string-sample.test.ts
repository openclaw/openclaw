import { describe, expect, it } from "vitest";
import { summarizeStringEntries } from "./string-sample.js";

describe("summarizeStringEntries", () => {
  it("returns emptyText for empty lists", () => {
    expect(summarizeStringEntries({ entries: [], emptyText: "any" })).toBe("any");
  });

  it("joins short lists without a suffix", () => {
    expect(summarizeStringEntries({ entries: ["a", "b"], limit: 4 })).toBe("a, b");
  });

  it("adds a remainder suffix when truncating", () => {
    expect(
      summarizeStringEntries({
        entries: ["a", "b", "c", "d", "e"],
        limit: 4,
      }),
    ).toBe("a, b, c, d (+1)");
  });
});

import { describe, expect, it } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

describe("normalizeAllowFrom", () => {
  it("accepts positive sender IDs and negative group chat IDs", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456", "@someone"]);

    expect(result).toEqual({
      entries: ["-1001234567890", "-100999", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone"],
    });
  });

  it("accepts numeric entries as integers", () => {
    const result = normalizeAllowFrom([-1003890514701, 745123456]);

    expect(result).toEqual({
      entries: ["-1003890514701", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("handles wildcard correctly", () => {
    const result = normalizeAllowFrom(["*", "123"]);

    expect(result).toEqual({
      entries: ["123"],
      hasWildcard: true,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("returns empty for undefined input", () => {
    const result = normalizeAllowFrom(undefined);

    expect(result).toEqual({
      entries: [],
      hasWildcard: false,
      hasEntries: false,
      invalidEntries: [],
    });
  });
});

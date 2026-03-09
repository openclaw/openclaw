import { describe, expect, it } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

describe("normalizeAllowFrom", () => {
  it("accepts positive sender IDs", () => {
    const result = normalizeAllowFrom(["745123456", "123"]);
    expect(result).toEqual({
      entries: ["745123456", "123"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("accepts negative Telegram group chat IDs", () => {
    const result = normalizeAllowFrom(["-1003890514701", " tg:-100999 ", "745123456"]);
    expect(result).toEqual({
      entries: ["-1003890514701", "-100999", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("rejects non-numeric strings", () => {
    const result = normalizeAllowFrom(["@someone", "abc", "12.34"]);
    expect(result).toEqual({
      entries: [],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone", "abc", "12.34"],
    });
  });

  it("handles wildcard", () => {
    const result = normalizeAllowFrom(["*", "745123456"]);
    expect(result).toEqual({
      entries: ["745123456"],
      hasWildcard: true,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("handles mixed valid and invalid entries", () => {
    const result = normalizeAllowFrom(["-1001234567890", "745123456", "@someone"]);
    expect(result).toEqual({
      entries: ["-1001234567890", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone"],
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

  it("strips telegram prefix before validation", () => {
    const result = normalizeAllowFrom(["telegram:-1001234567890", "tg:745123456"]);
    expect(result).toEqual({
      entries: ["-1001234567890", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });
});

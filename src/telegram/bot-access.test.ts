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

  it("accepts negative Telegram group/supergroup IDs (regression #40444)", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456"]);

    expect(result).toEqual({
      entries: ["-1001234567890", "-100999", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("rejects non-numeric entries", () => {
    const result = normalizeAllowFrom(["@someone", "abc", "12.34", ""]);

    expect(result).toEqual({
      entries: [],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone", "abc", "12.34"],
    });
  });

  it("handles wildcard entry", () => {
    const result = normalizeAllowFrom(["*", "745123456"]);

    expect(result).toEqual({
      entries: ["745123456"],
      hasWildcard: true,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("strips telegram/tg prefix before validation", () => {
    const result = normalizeAllowFrom(["telegram:123", "tg:-100999", "TG:456"]);

    expect(result).toEqual({
      entries: ["123", "-100999", "456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("handles numeric input alongside string input", () => {
    const result = normalizeAllowFrom([745123456, -1001234567890, "999"]);

    expect(result).toEqual({
      entries: ["745123456", "-1001234567890", "999"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("returns empty state for undefined input", () => {
    const result = normalizeAllowFrom(undefined);

    expect(result).toEqual({
      entries: [],
      hasWildcard: false,
      hasEntries: false,
      invalidEntries: [],
    });
  });
});

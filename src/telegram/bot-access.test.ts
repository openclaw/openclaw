import { describe, expect, it } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

describe("normalizeAllowFrom", () => {
  it("accepts positive sender IDs", () => {
    const result = normalizeAllowFrom(["745123456", " tg:123456 "]);

    expect(result).toEqual({
      entries: ["745123456", "123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("accepts negative group/supergroup chat IDs", () => {
    const result = normalizeAllowFrom(["-1001234567890", -100999, "745123456"]);

    expect(result).toEqual({
      entries: ["-1001234567890", "-100999", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("rejects non-numeric entries like @usernames", () => {
    const result = normalizeAllowFrom(["@someone", "not-a-number", "745123456"]);

    expect(result).toEqual({
      entries: ["745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone", "not-a-number"],
    });
  });

  it("handles mixed valid and invalid entries", () => {
    const result = normalizeAllowFrom([
      "-1001234567890",
      " tg:-100999 ",
      "745123456",
      "@someone",
    ]);

    expect(result).toEqual({
      entries: ["-1001234567890", "-100999", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone"],
    });
  });

  it("supports wildcard entry", () => {
    const result = normalizeAllowFrom(["*", "745123456"]);

    expect(result).toEqual({
      entries: ["745123456"],
      hasWildcard: true,
      hasEntries: true,
      invalidEntries: [],
    });
  });
});

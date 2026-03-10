import { describe, expect, it } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

describe("normalizeAllowFrom", () => {
  it("accepts positive sender IDs and negative group/supergroup chat IDs", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456", "@someone"]);

    expect(result).toEqual({
      entries: ["-1001234567890", "-100999", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone"],
    });
  });

  it("accepts wildcard", () => {
    const result = normalizeAllowFrom(["*"]);
    expect(result.hasWildcard).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("rejects non-numeric entries like @usernames", () => {
    const result = normalizeAllowFrom(["@username", "notanid"]);
    expect(result.invalidEntries).toEqual(["@username", "notanid"]);
    expect(result.entries).toEqual([]);
  });

  it("accepts negative supergroup IDs in groupAllowFrom", () => {
    const result = normalizeAllowFrom([-1003890514701]);
    expect(result.entries).toEqual(["-1003890514701"]);
    expect(result.invalidEntries).toEqual([]);
  });
});

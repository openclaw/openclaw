import { describe, expect, it } from "vitest";
import { normalizeAllowFrom, resolveSenderAllowMatch } from "./bot-access.js";

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

  it("accepts negative Telegram group/supergroup chat IDs in groupAllowFrom", () => {
    const result = normalizeAllowFrom(["-1001234567890", "-987654321"]);

    expect(result).toEqual({
      entries: ["-1001234567890", "-987654321"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("handles wildcard with negative IDs", () => {
    const result = normalizeAllowFrom(["*", "-1001234567890", "123"]);

    expect(result).toEqual({
      entries: ["-1001234567890", "123"],
      hasWildcard: true,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("strips tg: prefix from negative IDs", () => {
    const result = normalizeAllowFrom(["tg:-1001234567890"]);

    expect(result).toEqual({
      entries: ["-1001234567890"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
    });
  });
});

describe("resolveSenderAllowMatch", () => {
  it("matches a negative group chat ID in the allowlist", () => {
    const allow = normalizeAllowFrom(["-1001234567890"]);
    const result = resolveSenderAllowMatch({
      allow,
      senderId: "-1001234567890",
    });

    expect(result).toEqual({ allowed: true, matchKey: "-1001234567890", matchSource: "id" });
  });

  it("rejects a sender not in the allowlist", () => {
    const allow = normalizeAllowFrom(["-1001234567890"]);
    const result = resolveSenderAllowMatch({
      allow,
      senderId: "-999",
    });

    expect(result).toEqual({ allowed: false });
  });
});

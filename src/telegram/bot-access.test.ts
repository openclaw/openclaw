import { describe, expect, it } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

describe("normalizeAllowFrom", () => {
  it("accepts signed numeric Telegram IDs and rejects usernames", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456", "@someone"]);

    expect(result).toEqual({
      entries: ["-1001234567890", "-100999", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone"],
    });
  });
});

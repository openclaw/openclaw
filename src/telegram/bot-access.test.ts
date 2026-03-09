import { describe, expect, it } from "vitest";
import { normalizeAllowFrom, resolveSenderAllowMatch } from "./bot-access.js";

describe("telegram/bot-access", () => {
  it("accepts negative Telegram group IDs in allowlists", () => {
    const normalized = normalizeAllowFrom([-1003890514701, " tg:-12345 ", "*"]);

    expect(normalized).toEqual({
      entries: ["-1003890514701", "-12345"],
      hasWildcard: true,
      hasEntries: true,
      invalidEntries: [],
    });
  });

  it("matches negative sender IDs against normalized allowlists", () => {
    const allow = normalizeAllowFrom(["-1003890514701"]);

    expect(
      resolveSenderAllowMatch({
        allow,
        senderId: "-1003890514701",
      }),
    ).toEqual({
      allowed: true,
      matchKey: "-1003890514701",
      matchSource: "id",
    });
  });

  it("still rejects non-numeric allowlist entries", () => {
    const normalized = normalizeAllowFrom(["@username", "abc123"]);

    expect(normalized.entries).toEqual([]);
    expect(normalized.invalidEntries).toEqual(["@username", "abc123"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  isNumericTelegramChatId,
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  parseTelegramTarget,
  stripTelegramInternalPrefixes,
} from "./targets.js";

describe("stripTelegramInternalPrefixes", () => {
  it("strips telegram prefix", () => {
    expect(stripTelegramInternalPrefixes("telegram:123")).toBe("123");
  });

  it("strips telegram+group prefixes", () => {
    expect(stripTelegramInternalPrefixes("telegram:group:-100123")).toBe("-100123");
  });

  it("does not strip group prefix without telegram prefix", () => {
    expect(stripTelegramInternalPrefixes("group:-100123")).toBe("group:-100123");
  });

  it("is idempotent", () => {
    expect(stripTelegramInternalPrefixes("@mychannel")).toBe("@mychannel");
  });
});

describe("parseTelegramTarget", () => {
  it("parses plain chatId", () => {
    expect(parseTelegramTarget("-1001234567890")).toEqual({
      chatId: "-1001234567890",
      chatType: "group",
    });
  });

  it("parses @username", () => {
    expect(parseTelegramTarget("@mychannel")).toEqual({
      chatId: "@mychannel",
      chatType: "unknown",
    });
  });

  it("parses chatId:topicId format", () => {
    expect(parseTelegramTarget("-1001234567890:123")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 123,
      chatType: "group",
    });
  });

  it("parses chatId:topic:topicId format", () => {
    expect(parseTelegramTarget("-1001234567890:topic:456")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 456,
      chatType: "group",
    });
  });

  it("trims whitespace", () => {
    expect(parseTelegramTarget("  -1001234567890:99  ")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 99,
      chatType: "group",
    });
  });

  it("does not treat non-numeric suffix as topicId", () => {
    expect(parseTelegramTarget("-1001234567890:abc")).toEqual({
      chatId: "-1001234567890:abc",
      chatType: "unknown",
    });
  });

  it("strips internal prefixes before parsing", () => {
    expect(parseTelegramTarget("telegram:group:-1001234567890:topic:456")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 456,
      chatType: "group",
    });
  });
});

describe("normalizeTelegramChatId", () => {
  it("rejects username and t.me forms", () => {
    expect(normalizeTelegramChatId("telegram:https://t.me/MyChannel")).toBeUndefined();
    expect(normalizeTelegramChatId("tg:t.me/mychannel")).toBeUndefined();
    expect(normalizeTelegramChatId("@MyChannel")).toBeUndefined();
    expect(normalizeTelegramChatId("MyChannel")).toBeUndefined();
  });

  it("keeps numeric chat ids unchanged", () => {
    expect(normalizeTelegramChatId("-1001234567890")).toBe("-1001234567890");
    expect(normalizeTelegramChatId("123456789")).toBe("123456789");
  });

  it("returns undefined for empty input", () => {
    expect(normalizeTelegramChatId("  ")).toBeUndefined();
  });
});

describe("normalizeTelegramLookupTarget", () => {
  it("normalizes legacy t.me and username targets", () => {
    expect(normalizeTelegramLookupTarget("telegram:https://t.me/MyChannel")).toBe("@MyChannel");
    expect(normalizeTelegramLookupTarget("tg:t.me/mychannel")).toBe("@mychannel");
    expect(normalizeTelegramLookupTarget("@MyChannel")).toBe("@MyChannel");
    expect(normalizeTelegramLookupTarget("MyChannel")).toBe("@MyChannel");
  });

  it("keeps numeric chat ids unchanged", () => {
    expect(normalizeTelegramLookupTarget("-1001234567890")).toBe("-1001234567890");
    expect(normalizeTelegramLookupTarget("123456789")).toBe("123456789");
  });

  it("rejects invalid username forms", () => {
    expect(normalizeTelegramLookupTarget("@bad-handle")).toBeUndefined();
    expect(normalizeTelegramLookupTarget("bad-handle")).toBeUndefined();
    expect(normalizeTelegramLookupTarget("ab")).toBeUndefined();
  });
});

describe("isNumericTelegramChatId", () => {
  it("matches numeric telegram chat ids", () => {
    expect(isNumericTelegramChatId("-1001234567890")).toBe(true);
    expect(isNumericTelegramChatId("123456789")).toBe(true);
  });

  it("rejects non-numeric chat ids", () => {
    expect(isNumericTelegramChatId("@mychannel")).toBe(false);
    expect(isNumericTelegramChatId("t.me/mychannel")).toBe(false);
  });
});

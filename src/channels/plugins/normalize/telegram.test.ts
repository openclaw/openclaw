import { describe, expect, it } from "vitest";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./telegram.js";

describe("normalizeTelegramMessagingTarget", () => {
  it("normalizes t.me links to prefixed usernames", () => {
    expect(normalizeTelegramMessagingTarget("https://t.me/MyChannel")).toBe("telegram:@mychannel");
  });

  it("keeps legacy prefixed topic targets valid", () => {
    expect(normalizeTelegramMessagingTarget("telegram:group:-1001234567890:topic:456")).toBe(
      "telegram:group:-1001234567890:topic:456",
    );
    expect(normalizeTelegramMessagingTarget("tg:group:-1001234567890:topic:456")).toBe(
      "telegram:group:-1001234567890:topic:456",
    );
  });
});

describe("looksLikeTelegramTargetId", () => {
  it("recognizes legacy prefixed topic targets", () => {
    expect(looksLikeTelegramTargetId("telegram:group:-1001234567890:topic:456")).toBe(true);
    expect(looksLikeTelegramTargetId("tg:group:-1001234567890:topic:456")).toBe(true);
  });

  it("still recognizes normalized lookup targets", () => {
    expect(looksLikeTelegramTargetId("https://t.me/MyChannel")).toBe(true);
    expect(looksLikeTelegramTargetId("@mychannel")).toBe(true);
  });
});

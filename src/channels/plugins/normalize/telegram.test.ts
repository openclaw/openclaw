import { describe, expect, it } from "vitest";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./telegram.js";

describe("normalizeTelegramMessagingTarget", () => {
  it("normalizes t.me links to prefixed usernames", () => {
    expect(normalizeTelegramMessagingTarget("https://t.me/MyChannel")).toBe("telegram:@mychannel");
  });

  it("keeps unprefixed topic targets valid", () => {
    expect(normalizeTelegramMessagingTarget("@MyChannel:topic:9")).toBe(
      "telegram:@mychannel:topic:9",
    );
    expect(normalizeTelegramMessagingTarget("-1001234567890:topic:456")).toBe(
      "telegram:-1001234567890:topic:456",
    );
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
  it("recognizes unprefixed topic targets", () => {
    expect(looksLikeTelegramTargetId("@mychannel:topic:9")).toBe(true);
    expect(looksLikeTelegramTargetId("-1001234567890:topic:456")).toBe(true);
  });

  it("recognizes legacy prefixed topic targets", () => {
    expect(looksLikeTelegramTargetId("telegram:group:-1001234567890:topic:456")).toBe(true);
    expect(looksLikeTelegramTargetId("tg:group:-1001234567890:topic:456")).toBe(true);
  });

  it("still recognizes normalized lookup targets", () => {
    expect(looksLikeTelegramTargetId("https://t.me/MyChannel")).toBe(true);
    expect(looksLikeTelegramTargetId("@mychannel")).toBe(true);
  });
});

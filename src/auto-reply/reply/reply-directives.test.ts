import { describe, expect, it } from "vitest";
import { parseReplyDirectives } from "./reply-directives.js";

describe("parseReplyDirectives - sticker directive", () => {
  it("extracts STICKER: directive and preserves raw content", () => {
    const result = parseReplyDirectives("おはよう！\nSTICKER:11537:52002734");
    expect(result.text).toBe("おはよう！");
    expect(result.sticker).toEqual({ raw: "11537:52002734" });
  });

  it("handles text without sticker", () => {
    const result = parseReplyDirectives("普通のテキスト");
    expect(result.sticker).toBeUndefined();
  });

  it("handles sticker only (no text)", () => {
    const result = parseReplyDirectives("STICKER:446:1988");
    expect(result.text).toBe("");
    expect(result.sticker).toEqual({ raw: "446:1988" });
  });

  it("is case-insensitive", () => {
    const result = parseReplyDirectives("テスト\nsticker:446:1988");
    expect(result.sticker).toEqual({ raw: "446:1988" });
  });

  it("ignores empty STICKER: directive", () => {
    const result = parseReplyDirectives("テスト\nSTICKER:");
    expect(result.sticker).toBeUndefined();
    expect(result.text).toBe("テスト");
  });

  it("takes only first sticker if multiple present", () => {
    const result = parseReplyDirectives("テスト\nSTICKER:first\nSTICKER:second");
    expect(result.sticker).toEqual({ raw: "first" });
  });

  it("preserves arbitrary raw content for any channel", () => {
    const result = parseReplyDirectives("hello\nSTICKER:CAACAgIAAxkBAAI");
    expect(result.sticker).toEqual({ raw: "CAACAgIAAxkBAAI" });
  });

  it("detects sticker with leading whitespace", () => {
    const result = parseReplyDirectives("テスト\n  STICKER:446:1988");
    expect(result.sticker).toEqual({ raw: "446:1988" });
    expect(result.text).toBe("テスト");
  });

  it("detects sticker with trailing whitespace (raw is trimmed)", () => {
    const result = parseReplyDirectives("テスト\nSTICKER:446:1988   ");
    expect(result.sticker).toEqual({ raw: "446:1988" });
    expect(result.text).toBe("テスト");
  });

  it("coexists with MEDIA: directive", () => {
    const result = parseReplyDirectives(
      "テスト\nMEDIA:https://example.com/img.png\nSTICKER:446:1988",
    );
    expect(result.sticker).toEqual({ raw: "446:1988" });
    expect(result.mediaUrls).toContain("https://example.com/img.png");
    expect(result.text).toBe("テスト");
  });
});

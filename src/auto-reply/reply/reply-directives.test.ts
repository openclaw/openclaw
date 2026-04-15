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

  it("handles title-case Sticker directive", () => {
    const result = parseReplyDirectives("テスト\nSticker:446:1988");
    expect(result.sticker).toEqual({ raw: "446:1988" });
  });

  it("keeps empty STICKER: directive as text", () => {
    const result = parseReplyDirectives("テスト\nSTICKER:");
    expect(result.sticker).toBeUndefined();
    expect(result.text).toBe("テスト\nSTICKER:");
  });

  it("keeps whitespace-only STICKER payload as text", () => {
    const result = parseReplyDirectives("テスト\nSTICKER:   ");
    expect(result.sticker).toBeUndefined();
    expect(result.text).toBe("テスト\nSTICKER:");
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

  it("coexists with reply_to directive", () => {
    const result = parseReplyDirectives("テスト\n[[reply_to:msg123]]\nSTICKER:446:1988");
    expect(result.sticker).toEqual({ raw: "446:1988" });
    expect(result.replyToId).toBe("msg123");
    expect(result.replyToTag).toBe(true);
    expect(result.text).toBe("テスト");
  });

  it("parses sticker when MEDIA appears after sticker", () => {
    const result = parseReplyDirectives(
      "STICKER:446:1988\nMEDIA:https://example.com/img.png\nテスト",
    );
    expect(result.sticker).toEqual({ raw: "446:1988" });
    expect(result.mediaUrls).toEqual(["https://example.com/img.png"]);
    expect(result.text).toBe("テスト");
  });

  it("retains text and picks only the first sticker in mixed content", () => {
    const result = parseReplyDirectives("STICKER:446:1988\n通常テキスト\nSTICKER:789:10858");
    expect(result.sticker).toEqual({ raw: "446:1988" });
    expect(result.text).toBe("通常テキスト");
  });

  it.each([
    { input: "STICKER:abc", expectedRaw: "abc" },
    { input: "STICKER:446", expectedRaw: "446" },
    { input: "STICKER:446:1988:extra", expectedRaw: "446:1988:extra" },
  ])("keeps raw sticker token as-is for invalid LINE formats: $input", ({ input, expectedRaw }) => {
    const result = parseReplyDirectives(input);
    expect(result.sticker).toEqual({ raw: expectedRaw });
  });

  it("does not extract STICKER directives from fenced code blocks", () => {
    const result = parseReplyDirectives(
      "Here is code:\n```txt\nSTICKER:446:1988\n```\nActual sticker below\nSTICKER:1070:17844",
    );
    expect(result.sticker).toEqual({ raw: "1070:17844" });
    expect(result.text).toBe("Here is code:\n```txt\nSTICKER:446:1988\n```\nActual sticker below");
  });
});

import { describe, expect, it } from "vitest";
import { splitTelegramCaption, TELEGRAM_MAX_CAPTION_LENGTH } from "./caption.js";

describe("splitTelegramCaption", () => {
  it("returns both undefined for undefined input", () => {
    const result = splitTelegramCaption(undefined);
    expect(result.caption).toBeUndefined();
    expect(result.followUpText).toBeUndefined();
  });

  it("returns both undefined for empty string", () => {
    const result = splitTelegramCaption("");
    expect(result.caption).toBeUndefined();
    expect(result.followUpText).toBeUndefined();
  });

  it("returns both undefined for whitespace-only", () => {
    const result = splitTelegramCaption("   ");
    expect(result.caption).toBeUndefined();
    expect(result.followUpText).toBeUndefined();
  });

  it("returns caption for text within limit", () => {
    const result = splitTelegramCaption("Hello!");
    expect(result.caption).toBe("Hello!");
    expect(result.followUpText).toBeUndefined();
  });

  it("returns caption for text exactly at limit", () => {
    const text = "a".repeat(TELEGRAM_MAX_CAPTION_LENGTH);
    const result = splitTelegramCaption(text);
    expect(result.caption).toBe(text);
    expect(result.followUpText).toBeUndefined();
  });

  it("returns followUpText when over limit", () => {
    const text = "a".repeat(TELEGRAM_MAX_CAPTION_LENGTH + 1);
    const result = splitTelegramCaption(text);
    expect(result.caption).toBeUndefined();
    expect(result.followUpText).toBe(text);
  });

  it("trims text before checking length", () => {
    const result = splitTelegramCaption("  hello  ");
    expect(result.caption).toBe("hello");
  });

  it("exports correct max caption length", () => {
    expect(TELEGRAM_MAX_CAPTION_LENGTH).toBe(1024);
  });
});

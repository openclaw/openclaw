import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateTokensFromChars,
} from "./cjk-chars.js";

describe("estimateStringChars", () => {
  it("returns plain string length for ASCII text", () => {
    expect(estimateStringChars("hello world")).toBe(11);
  });

  it("returns 0 for empty string", () => {
    expect(estimateStringChars("")).toBe(0);
  });

  it("counts Chinese characters with extra weight", () => {
    // "你好世" = 3 CJK chars
    // Each CJK char counted as CHARS_PER_TOKEN_ESTIMATE (4) chars
    // .length = 3, adjusted = 3 + 3 * (4 - 1) = 12
    expect(estimateStringChars("你好世")).toBe(12);
  });

  it("handles mixed ASCII and CJK text", () => {
    // "hi你好" = 2 ASCII + 2 CJK
    // .length = 4, adjusted = 4 + 2 * 3 = 10
    expect(estimateStringChars("hi你好")).toBe(10);
  });

  it("handles Japanese hiragana", () => {
    // "こんにちは" = 5 hiragana chars
    // .length = 5, adjusted = 5 + 5 * 3 = 20
    expect(estimateStringChars("こんにちは")).toBe(20);
  });

  it("handles Japanese katakana", () => {
    // "カタカナ" = 4 katakana chars
    // .length = 4, adjusted = 4 + 4 * 3 = 16
    expect(estimateStringChars("カタカナ")).toBe(16);
  });

  it("handles Korean hangul", () => {
    // "안녕하세요" = 5 hangul chars
    // .length = 5, adjusted = 5 + 5 * 3 = 20
    expect(estimateStringChars("안녕하세요")).toBe(20);
  });

  it("handles CJK punctuation and symbols in the extended range", () => {
    // "⺀" (U+2E80) is in CJK Radicals Supplement range
    expect(estimateStringChars("⺀")).toBe(CHARS_PER_TOKEN_ESTIMATE);
  });

  it("does not inflate standard Latin characters", () => {
    const latin = "The quick brown fox jumps over the lazy dog";
    expect(estimateStringChars(latin)).toBe(latin.length);
  });

  it("does not inflate numbers and basic punctuation", () => {
    const text = "123.45, hello! @#$%";
    expect(estimateStringChars(text)).toBe(text.length);
  });

  it("yields ~1 token per CJK char when divided by CHARS_PER_TOKEN_ESTIMATE", () => {
    // 10 CJK chars should estimate as ~10 tokens
    const cjk = "这是一个测试用的句子呢";
    const estimated = estimateStringChars(cjk);
    const tokens = Math.ceil(estimated / CHARS_PER_TOKEN_ESTIMATE);
    // Each CJK char ≈ 1 token, so tokens should be close to string length
    expect(tokens).toBe(cjk.length);
  });
});

describe("estimateTokensFromChars", () => {
  it("divides by CHARS_PER_TOKEN_ESTIMATE and rounds up", () => {
    expect(estimateTokensFromChars(8)).toBe(2);
    expect(estimateTokensFromChars(9)).toBe(3);
    expect(estimateTokensFromChars(0)).toBe(0);
  });

  it("clamps negative values to 0", () => {
    expect(estimateTokensFromChars(-10)).toBe(0);
  });
});

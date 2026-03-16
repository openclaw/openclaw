import { describe, expect, it } from "vitest";
import { detectSessionReplyLanguageFromText } from "./session-language.js";

describe("detectSessionReplyLanguageFromText", () => {
  it("returns zh-Hans for pure Chinese text with at least two Han characters", () => {
    expect(detectSessionReplyLanguageFromText("你好世界")).toBe("zh-Hans");
    expect(detectSessionReplyLanguageFromText("测试")).toBe("zh-Hans");
  });

  it("returns en for pure English text with at least six Latin characters", () => {
    expect(detectSessionReplyLanguageFromText("Hello World")).toBe("en");
    expect(detectSessionReplyLanguageFromText("testing something")).toBe("en");
  });

  it("returns zh-Hans when mixed content meets the Han threshold", () => {
    expect(detectSessionReplyLanguageFromText("你好世界 hello")).toBe("zh-Hans");
    expect(detectSessionReplyLanguageFromText("测试一下 testing")).toBe("zh-Hans");
  });

  it("returns undefined for empty or below-threshold inputs", () => {
    expect(detectSessionReplyLanguageFromText("")).toBeUndefined();
    expect(detectSessionReplyLanguageFromText("   \t\n  ")).toBeUndefined();
    expect(detectSessionReplyLanguageFromText("12345")).toBeUndefined();
    expect(detectSessionReplyLanguageFromText("你")).toBeUndefined();
    expect(detectSessionReplyLanguageFromText("Hi")).toBeUndefined();
    expect(detectSessionReplyLanguageFromText("abc")).toBeUndefined();
  });

  it("returns undefined for URL-heavy text that does not meet the Han threshold", () => {
    expect(detectSessionReplyLanguageFromText("请看 https://example.com/path")).toBeUndefined();
  });
});

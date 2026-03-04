import { describe, expect, it } from "vitest";
import { isReasoningTagProvider } from "./provider-utils.js";

describe("isReasoningTagProvider", () => {
  it("returns true for exact match: ollama", () => {
    expect(isReasoningTagProvider("ollama")).toBe(true);
  });

  it("returns true for exact match: google-gemini-cli", () => {
    expect(isReasoningTagProvider("google-gemini-cli")).toBe(true);
  });

  it("returns true for exact match: google-generative-ai", () => {
    expect(isReasoningTagProvider("google-generative-ai")).toBe(true);
  });

  it("returns true for google-antigravity substring", () => {
    expect(isReasoningTagProvider("google-antigravity")).toBe(true);
    expect(isReasoningTagProvider("google-antigravity/gemini-3")).toBe(true);
  });

  it("returns true for minimax substring", () => {
    expect(isReasoningTagProvider("minimax")).toBe(true);
    expect(isReasoningTagProvider("minimax-portal")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isReasoningTagProvider("OLLAMA")).toBe(true);
    expect(isReasoningTagProvider("Google-Gemini-CLI")).toBe(true);
    expect(isReasoningTagProvider("MINIMAX")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isReasoningTagProvider("  ollama  ")).toBe(true);
  });

  it("returns false for null", () => {
    expect(isReasoningTagProvider(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isReasoningTagProvider(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isReasoningTagProvider("")).toBe(false);
  });

  it("returns false for unrelated providers", () => {
    expect(isReasoningTagProvider("anthropic")).toBe(false);
    expect(isReasoningTagProvider("openai")).toBe(false);
    expect(isReasoningTagProvider("deepseek")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isReasoningTagProvider } from "./provider-utils.js";

describe("isReasoningTagProvider", () => {
  it("returns false for ollama — native reasoning field, no tags needed (#2279)", () => {
    expect(isReasoningTagProvider("ollama")).toBe(false);
    expect(isReasoningTagProvider("Ollama")).toBe(false);
  });

  it("returns true for google-gemini-cli", () => {
    expect(isReasoningTagProvider("google-gemini-cli")).toBe(true);
  });

  it("returns true for google-generative-ai", () => {
    expect(isReasoningTagProvider("google-generative-ai")).toBe(true);
  });

  it("returns true for google-antigravity", () => {
    expect(isReasoningTagProvider("google-antigravity")).toBe(true);
    expect(isReasoningTagProvider("google-antigravity/gemini-3")).toBe(true);
  });

  it("returns true for minimax", () => {
    expect(isReasoningTagProvider("minimax")).toBe(true);
    expect(isReasoningTagProvider("minimax-cn")).toBe(true);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isReasoningTagProvider(null)).toBe(false);
    expect(isReasoningTagProvider(undefined)).toBe(false);
    expect(isReasoningTagProvider("")).toBe(false);
  });

  it("returns false for standard providers", () => {
    expect(isReasoningTagProvider("anthropic")).toBe(false);
    expect(isReasoningTagProvider("openai")).toBe(false);
    expect(isReasoningTagProvider("openrouter")).toBe(false);
  });
});

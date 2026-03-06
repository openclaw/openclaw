import { describe, expect, it } from "vitest";
import { maskApiKey } from "./mask-api-key.js";

describe("maskApiKey", () => {
  it("returns missing for empty values", () => {
    expect(maskApiKey("")).toBe("missing");
    expect(maskApiKey("   ")).toBe("missing");
  });

  // --- Provider-prefixed keys (most common) ---

  it("masks OpenRouter keys (sk-or-...)", () => {
    expect(maskApiKey("sk-or-v1-abc123def456")).toBe("sk-or-***");
  });

  it("masks Claude/Copilot keys (sk-cp-...)", () => {
    expect(maskApiKey("sk-cp-NlHpbk1234567890abcdef")).toBe("sk-cp-***");
  });

  it("masks Anthropic keys (sk-ant-...)", () => {
    expect(maskApiKey("sk-ant-api03-longsecretvalue")).toBe("sk-ant-***");
  });

  it("masks OpenAI keys (sk-proj-...)", () => {
    expect(maskApiKey("sk-proj-abc123def456ghi789")).toBe("sk-proj-***");
  });

  it("masks Groq keys (gsk_...)", () => {
    expect(maskApiKey("gsk_abc123def456ghi789jkl012")).toBe("gsk_***");
  });

  // --- Keys without standard prefixes ---

  it("masks keys with no separator using first 4 chars", () => {
    expect(maskApiKey("abcdefghijklmnop")).toBe("abcd***");
  });

  it("masks very short keys with first 4 chars", () => {
    expect(maskApiKey("abc")).toBe("abc***");
  });

  // --- Security: never reveals the tail of the key ---

  it("never shows the end of the key", () => {
    const key = "sk-or-v1-abc123def456ghi789jkl012mno345pqr678";
    const masked = maskApiKey(key);
    // The last 8 characters should never appear in the output.
    const tail = key.slice(-8);
    expect(masked).not.toContain(tail);
    // Should only show prefix + ***.
    expect(masked).toBe("sk-or-***");
  });

  it("never shows the full key for short keys", () => {
    const shortKey = "sk-test123";
    const masked = maskApiKey(shortKey);
    expect(masked).not.toBe(shortKey);
    expect(masked).toBe("sk-***");
  });

  it("masks keys with only one separator (e.g. sk-longrandomvalue)", () => {
    expect(maskApiKey("sk-longrandomvaluehere1234567890")).toBe("sk-***");
  });

  it("handles single-char keys safely", () => {
    expect(maskApiKey("x")).toBe("x***");
  });
});

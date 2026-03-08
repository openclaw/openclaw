import { describe, expect, it } from "vitest";

/**
 * Test the sanitizeLoneSurrogates function behavior.
 * This function is not exported, so we test it indirectly through the embedding operations.
 * However, we can test the logic directly here.
 */
describe("lone surrogate sanitization", () => {
  function sanitizeLoneSurrogates(text: string): string {
    let result = "";
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      // High surrogate (U+D800-U+DBFF)
      if (code >= 0xd800 && code <= 0xdbff) {
        const nextCode = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
        // Check if followed by low surrogate (U+DC00-U+DFFF)
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          // Valid surrogate pair, keep both
          result += text[i] + text[i + 1];
          i++; // Skip the low surrogate
        } else {
          // Lone high surrogate, replace with U+FFFD
          result += "\uFFFD";
        }
      }
      // Low surrogate (U+DC00-U+DFFF) without preceding high surrogate
      else if (code >= 0xdc00 && code <= 0xdfff) {
        // Lone low surrogate, replace with U+FFFD
        result += "\uFFFD";
      } else {
        // Normal character
        result += text[i];
      }
    }
    return result;
  }

  it("replaces lone high surrogate with replacement character", () => {
    const input = "Hello \uD83C World";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("Hello \uFFFD World");
  });

  it("replaces lone low surrogate with replacement character", () => {
    const input = "Hello \uDF4C World";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("Hello \uFFFD World");
  });

  it("preserves valid surrogate pairs (emoji)", () => {
    const input = "Hello 🎉 World"; // U+1F389 (PARTY POPPER)
    const output = sanitizeLoneSurrogates(input);
    // Valid surrogate pairs should be preserved
    expect(output).toBe("Hello 🎉 World");
  });

  it("replaces multiple lone surrogates", () => {
    // Lone high surrogate, lone high surrogate, lone low surrogate
    const input = "\uD83C text \uD800 more \uDF4C";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("\uFFFD text \uFFFD more \uFFFD");
  });

  it("handles mixed valid and invalid surrogates", () => {
    const input = "Valid: 🎉 Invalid: \uD83C End";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("Valid: 🎉 Invalid: \uFFFD End");
  });

  it("preserves normal ASCII text", () => {
    const input = "Hello World 123";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("Hello World 123");
  });

  it("preserves other Unicode characters", () => {
    const input = "Hello 世界 مرحبا";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("Hello 世界 مرحبا");
  });

  it("handles empty string", () => {
    const input = "";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("");
  });

  it("handles lone high surrogate at end of string", () => {
    const input = "Text\uD83C";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("Text\uFFFD");
  });

  it("handles lone low surrogate at start of string", () => {
    const input = "\uDF4CText";
    const output = sanitizeLoneSurrogates(input);
    expect(output).toBe("\uFFFDText");
  });
});

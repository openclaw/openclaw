import { describe, expect, it } from "vitest";
import { markdownToTelegramChunks } from "./format.js";

describe("splitMarkdownIRPreserveWhitespace – word boundary splitting", () => {
  it("does not split words mid-character (issue #36644)", () => {
    const text =
      "Regulatory overhang lifts beta for UK banks and creates investment opportunities in the sector";
    const chunks = markdownToTelegramChunks(text, 35);

    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(text);

    // "beta" must appear as a complete word in exactly one chunk
    const betaChunks = chunks.filter((c) => /\bbeta\b/.test(c.text));
    expect(betaChunks).toHaveLength(1);

    // No chunk should be a single-letter fragment of "beta"
    const hasFragment = chunks.some(
      (c) => c.text.trim() === "b" || c.text.trim() === "e" || c.text.trim() === "ta",
    );
    expect(hasFragment).toBe(false);
  });

  it("splits at whitespace boundaries", () => {
    const text = "hello world this is a test of word boundary splitting logic";
    const chunks = markdownToTelegramChunks(text, 20);

    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(text);

    // Non-final chunks should end at a whitespace boundary
    for (let i = 0; i < chunks.length - 1; i++) {
      const chunkText = chunks[i].text;
      const lastChar = chunkText[chunkText.length - 1];
      const nextStart = chunks[i + 1].text[0];
      // Either chunk ends with space or next starts without a partial word continuation
      expect(lastChar === " " || nextStart === " " || /^\s/.test(chunks[i + 1].text)).toBe(true);
    }
  });

  it("falls back to character boundary for a single long word", () => {
    const longWord = "Supercalifragilisticexpialidocious";
    const chunks = markdownToTelegramChunks(longWord, 10);

    expect(chunks.length).toBeGreaterThan(1);
    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(longWord);
  });

  it("handles newlines as valid split points", () => {
    const text = "Line one content\nLine two content\nLine three content";
    const chunks = markdownToTelegramChunks(text, 20);

    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(text);
  });

  it("preserves text exactly when under the limit", () => {
    const text = "Short text";
    const chunks = markdownToTelegramChunks(text, 100);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
  });

  it("preserves markdown formatting across word-boundary splits", () => {
    const text =
      "This has **bold text** and _italic_ with a lot more words to push it past the limit";
    const chunks = markdownToTelegramChunks(text, 40);

    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(text);

    // HTML should be present on all chunks
    for (const chunk of chunks) {
      expect(chunk.html).toBeDefined();
      expect(typeof chunk.html).toBe("string");
    }
  });

  it("handles empty input", () => {
    const chunks = markdownToTelegramChunks("", 100);
    expect(chunks).toHaveLength(0);
  });
});

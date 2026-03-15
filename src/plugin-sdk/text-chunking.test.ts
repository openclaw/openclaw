import { describe, expect, it } from "vitest";
import { chunkTextForOutbound } from "./text-chunking.js";

describe("plugin-sdk/text-chunking", () => {
  it("returns single chunk for text under limit", () => {
    expect(chunkTextForOutbound("hello world", 100)).toEqual(["hello world"]);
  });

  it("splits at newlines when possible", () => {
    const text = "line one\nline two\nline three";
    expect(chunkTextForOutbound(text, 15)).toEqual(["line one\nline two", "line three"]);
  });

  it("splits at spaces when no newlines available", () => {
    expect(chunkTextForOutbound("alpha beta gamma", 10)).toEqual(["alpha", "beta gamma"]);
  });

  describe("code block awareness", () => {
    it("does not split inside a code block", () => {
      const code = "```\ncode line one\ncode line two\n```";
      // The entire code block should stay together if it fits
      expect(chunkTextForOutbound(code, 100)).toEqual([code]);
    });

    it("breaks after code block ends when possible", () => {
      const text = "```\ncode here\n```\nNext paragraph after code block.";
      const chunks = chunkTextForOutbound(text, 30);
      // Should break at the newline after the code block, not inside it
      expect(chunks.length).toBeGreaterThan(1);
      // First chunk should end with ``` (code block closed)
      expect(chunks[0].endsWith("```")).toBe(true);
    });

    it("prefers breaking before a code block starts", () => {
      const text = "Some text before.\n```\ncode\n```";
      const chunks = chunkTextForOutbound(text, 20);
      // If we must split, prefer keeping the code block intact
      for (const chunk of chunks) {
        // Each chunk either has no code block or has a complete one
        const openCount = (chunk.match(/```/g) || []).length;
        expect(openCount % 2).toBe(0); // Even number means all blocks are closed
      }
    });

    it("handles multiple code blocks", () => {
      const text = "```\nfirst\n```\n```\nsecond\n```";
      const chunks = chunkTextForOutbound(text, 20);
      // Each chunk should have balanced code blocks
      for (const chunk of chunks) {
        const openCount = (chunk.match(/```/g) || []).length;
        expect(openCount % 2).toBe(0);
      }
    });

    it("handles code block with language specifier", () => {
      const text = "```typescript\nconst x = 1;\n```";
      expect(chunkTextForOutbound(text, 100)).toEqual([text]);
    });

    it("handles unclosed code block gracefully", () => {
      const text = "```\nthis has no closing marker";
      const chunks = chunkTextForOutbound(text, 15);
      // Should still produce chunks, even if malformed
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });
});
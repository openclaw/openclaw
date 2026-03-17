/**
 * Tests for the advanced chunker (Phase 3).
 */

import { describe, it, expect } from "vitest";
import {
  AdvancedChunker,
  advancedChunker,
  chunkMarkdownAdvanced,
  calculateDynamicOverlap,
  analyzeContentType,
  extractSectionHeading,
  DEFAULT_DYNAMIC_OVERLAP,
  type EnhancedMemoryChunk,
} from "./advanced-chunker.js";
import { DEFAULT_CHUNKING_CONFIG } from "./chunk-strategy.js";

describe("chunking.advancedChunker", () => {
  describe("AdvancedChunker", () => {
    it("has the correct name", () => {
      expect(advancedChunker.name).toBe("advanced");
    });

    it("can be instantiated with custom options", () => {
      const chunker = new AdvancedChunker({
        dynamicOverlapConfig: {
          baseOverlapBytes: 300,
          codeOverlapMultiplier: 2.0,
        },
        enableHierarchicalContext: true,
        enableCrossReferences: true,
      });

      expect(chunker).toBeDefined();
    });
  });

  describe("chunkMarkdownAdvanced", () => {
    it("returns enhanced chunks with metadata", () => {
      const content = "# Test\n\nSome content here.";

      const chunks = chunkMarkdownAdvanced(content, DEFAULT_CHUNKING_CONFIG);

      expect(chunks.length).toBeGreaterThan(0);

      const chunk = chunks[0];
      expect(chunk).toBeDefined();
      expect(chunk.chunkId).toBeDefined();
      expect(chunk.metadata).toBeDefined();
    });

    it("detects section headings", () => {
      const content = `# Main Title

Content under main title.

## Subsection

Content under subsection.`;

      const chunks = chunkMarkdownAdvanced(content, {
        maxBytes: 50,
        overlapBytes: 0,
      });

      // Find chunks with section headings
      const chunksWithHeadings = chunks.filter(
        (c) => c.metadata.sectionHeading,
      );

      expect(chunksWithHeadings.length).toBeGreaterThan(0);

      // Verify heading level is captured
      const withLevel = chunksWithHeadings.find(
        (c) => c.metadata.sectionLevel !== undefined,
      );
      expect(withLevel).toBeDefined();
    });

    it("detects code content", () => {
      const content = `Some text

\`\`\`javascript
const x = 42;
\`\`\`

More text`;

      const chunks = chunkMarkdownAdvanced(content, DEFAULT_CHUNKING_CONFIG);

      const codeChunks = chunks.filter((c) => c.metadata.hasCode);
      expect(codeChunks.length).toBeGreaterThan(0);
    });

    it("analyzes content types correctly", () => {
      const testCases = [
        { content: "# Heading", expectedType: "heading" },
        { content: "```js\ncode\n```", expectedType: "code" },
        { content: "- item 1\n- item 2", expectedType: "list" },
        { content: "> quote", expectedType: "blockquote" },
        { content: "Plain text paragraph.", expectedType: "prose" },
      ];

      for (const { content, expectedType } of testCases) {
        const lines = content.split("\n");
        const type = analyzeContentType(lines);
        expect(type).toBe(expectedType);
      }
    });

    it("detects mixed content", () => {
      const content = "Text\n\n```js\ncode\n```\n\nMore text";
      const chunks = chunkMarkdownAdvanced(content, DEFAULT_CHUNKING_CONFIG);

      const mixedChunks = chunks.filter((c) => c.metadata.contentType === "mixed");
      expect(mixedChunks.length).toBeGreaterThan(0);
    });

    it("creates cross-chunk references", () => {
      const content = `# Section 1

Content 1

# Section 2

Content 2

# Section 3

Content 3`;

      const chunks = chunkMarkdownAdvanced(content, {
        maxBytes: 30,
        overlapBytes: 0,
      });

      expect(chunks.length).toBeGreaterThan(1);

      // Check middle chunks have both previous and next
      const middleChunks = chunks.slice(1, -1);
      for (const chunk of middleChunks) {
        expect(chunk.metadata.neighbors.previousChunkId).toBeDefined();
        expect(chunk.metadata.neighbors.nextChunkId).toBeDefined();
      }
    });

    it("finds parent section references", () => {
      const content = `# Main

Main content

## Sub 1

Sub content 1

## Sub 2

Sub content 2`;

      const chunks = chunkMarkdownAdvanced(content, {
        maxBytes: 40,
        overlapBytes: 0,
      });

      // Find sub-section chunks
      const subChunks = chunks.filter((c) =>
        c.metadata.sectionHeading?.startsWith("##"),
      );

      // They should reference parent
      const withParent = subChunks.filter((c) =>
        c.metadata.neighbors.parentChunkId,
      );
      expect(withParent.length).toBeGreaterThan(0);
    });

    it("generates unique chunk IDs", () => {
      const content = "Line 1\nLine 2\nLine 3";
      const chunks = chunkMarkdownAdvanced(content, DEFAULT_CHUNKING_CONFIG);

      const ids = new Set(chunks.map((c) => c.chunkId));
      expect(ids.size).toBe(chunks.length);
    });

    it("preserves base MemoryChunk properties", () => {
      const content = "# Test\n\nContent";
      const chunks = chunkMarkdownAdvanced(content, DEFAULT_CHUNKING_CONFIG);

      const chunk = chunks[0];
      expect(chunk).toMatchObject({
        startLine: expect.any(Number),
        endLine: expect.any(Number),
        text: expect.any(String),
        hash: expect.any(String),
        embeddingInput: { text: expect.any(String) },
      });
    });
  });

  describe("calculateDynamicOverlap", () => {
    it("uses base overlap for prose", () => {
      const overlap = calculateDynamicOverlap("prose", false);
      expect(overlap).toBe(DEFAULT_DYNAMIC_OVERLAP.baseOverlapBytes);
    });

    it("increases overlap for code", () => {
      const proseOverlap = calculateDynamicOverlap("prose", false);
      const codeOverlap = calculateDynamicOverlap("code", false);

      expect(codeOverlap).toBeGreaterThan(proseOverlap);
    });

    it("increases overlap for lists", () => {
      const proseOverlap = calculateDynamicOverlap("prose", false);
      const listOverlap = calculateDynamicOverlap("list", false);

      expect(listOverlap).toBeGreaterThan(proseOverlap);
    });

    it("decreases overlap for headings", () => {
      const proseOverlap = calculateDynamicOverlap("prose", false);
      const headingOverlap = calculateDynamicOverlap("heading", false);

      expect(headingOverlap).toBeLessThan(proseOverlap);
    });

    it("respects minimum overlap", () => {
      const overlap = calculateDynamicOverlap("heading", false, {
        ...DEFAULT_DYNAMIC_OVERLAP,
        baseOverlapBytes: 10,
        minOverlapBytes: 50,
      });

      expect(overlap).toBeGreaterThanOrEqual(50);
    });

    it("respects maximum overlap", () => {
      const overlap = calculateDynamicOverlap("code", true, {
        ...DEFAULT_DYNAMIC_OVERLAP,
        baseOverlapBytes: 1000,
        codeOverlapMultiplier: 10,
        maxOverlapBytes: 500,
      });

      expect(overlap).toBeLessThanOrEqual(500);
    });

    it("applies code bonus when hasCode is true", () => {
      const withoutCode = calculateDynamicOverlap("prose", false);
      const withCode = calculateDynamicOverlap("prose", true);

      expect(withCode).toBeGreaterThan(withoutCode);
    });
  });

  describe("analyzeContentType", () => {
    it("identifies pure heading content", () => {
      const lines = ["# Heading", "## Subheading"];
      expect(analyzeContentType(lines)).toBe("heading");
    });

    it("identifies pure code blocks", () => {
      const lines = ["```js", "code", "```"];
      expect(analyzeContentType(lines)).toBe("code");
    });

    it("identifies pure lists", () => {
      const lines = ["- item 1", "- item 2", "* item 3"];
      expect(analyzeContentType(lines)).toBe("list");
    });

    it("identifies pure blockquotes", () => {
      const lines = ["> quote 1", "> quote 2"];
      expect(analyzeContentType(lines)).toBe("blockquote");
    });

    it("identifies pure prose", () => {
      const lines = ["Some text", "More text", "Even more text"];
      expect(analyzeContentType(lines)).toBe("prose");
    });

    it("identifies mixed content", () => {
      expect(analyzeContentType(["# Heading", "text"])).toBe("mixed");
      expect(analyzeContentType(["text", "```js", "code", "```"])).toBe("mixed");
      expect(analyzeContentType(["- item", "text"])).toBe("mixed");
    });
  });

  describe("extractSectionHeading", () => {
    it("finds the nearest preceding heading", () => {
      const lines = [
        "text",
        "# Heading 1",
        "more text",
        "## Heading 2",
        "target line",
      ];

      const result = extractSectionHeading(lines, 4);
      expect(result.heading).toContain("Heading 2");
      expect(result.level).toBe(2);
    });

    it("returns undefined when no heading exists", () => {
      const lines = ["text", "more text", "even more"];
      const result = extractSectionHeading(lines, 2);

      expect(result.heading).toBeUndefined();
      expect(result.level).toBe(0);
    });

    it("finds level 1 heading", () => {
      const lines = ["# Main", "content"];
      const result = extractSectionHeading(lines, 1);

      expect(result.heading).toBe("# Main");
      expect(result.level).toBe(1);
    });

    it("finds level 6 heading", () => {
      const lines = ["###### Small", "content"];
      const result = extractSectionHeading(lines, 1);

      expect(result.level).toBe(6);
    });

    it("skips non-heading lines", () => {
      const lines = [
        "text",
        "more text",
        "# Actual Heading",
        "content",
        "target",
      ];

      const result = extractSectionHeading(lines, 4);
      expect(result.heading).toContain("Actual Heading");
    });
  });

  describe("AdvancedChunker options", () => {
    it("respects enableHierarchicalContext option", () => {
      const chunker = new AdvancedChunker({
        enableHierarchicalContext: true,
      });

      expect(chunker).toBeDefined();
    });

    it("respects enableCrossReferences option", () => {
      const content = "# Section 1\n\nContent 1\n\n# Section 2\n\nContent 2";

      const withRefs = chunkMarkdownAdvanced(
        content,
        { maxBytes: 30, overlapBytes: 0 },
        { enableCrossReferences: true },
      );

      const withoutRefs = chunkMarkdownAdvanced(
        content,
        { maxBytes: 30, overlapBytes: 0 },
        { enableCrossReferences: false },
      );

      // With references, chunks should have neighbor info
      const withNeighbors = withRefs.filter(
        (c) =>
          c.metadata.neighbors.previousChunkId ||
          c.metadata.neighbors.nextChunkId,
      );
      expect(withNeighbors.length).toBeGreaterThan(0);

      // Without references, no chunks should have neighbors
      const withoutNeighbors = withoutRefs.filter(
        (c) =>
          c.metadata.neighbors.previousChunkId ||
          c.metadata.neighbors.nextChunkId,
      );
      expect(withoutNeighbors.length).toBe(0);
    });

    it("applies custom dynamic overlap config", () => {
      const customOverlap = calculateDynamicOverlap("code", false, {
        baseOverlapBytes: 500,
        codeOverlapMultiplier: 3,
        minOverlapBytes: 100,
        maxOverlapBytes: 2000,
      });

      // Should use custom base
      expect(customOverlap).toBe(500 * 3); // 1500

      // But respect max
      const clampedOverlap = calculateDynamicOverlap("code", true, {
        baseOverlapBytes: 500,
        codeOverlapMultiplier: 10,
        maxOverlapBytes: 1000,
      });
      expect(clampedOverlap).toBeLessThanOrEqual(1000);
    });
  });

  describe("integration with base ChunkStrategy", () => {
    it("implements ChunkStrategy interface", () => {
      const chunker = new AdvancedChunker();

      expect(chunker.name).toBeDefined();
      expect(typeof chunker.chunk).toBe("function");
    });

    it("returns MemoryChunk-compatible objects", () => {
      const content = "# Test\n\nContent";
      const chunker = new AdvancedChunker();

      const chunks = chunker.chunk(content, DEFAULT_CHUNKING_CONFIG);

      expect(Array.isArray(chunks)).toBe(true);
      expect(chunks.length).toBeGreaterThan(0);

      const chunk = chunks[0];
      expect(chunk).toHaveProperty("startLine");
      expect(chunk).toHaveProperty("endLine");
      expect(chunk).toHaveProperty("text");
      expect(chunk).toHaveProperty("hash");
      expect(chunk).toHaveProperty("embeddingInput");
    });

    it("handles empty content", () => {
      const chunker = new AdvancedChunker();
      const chunks = chunker.chunk("", DEFAULT_CHUNKING_CONFIG);

      expect(chunks).toEqual([]);
    });
  });
});

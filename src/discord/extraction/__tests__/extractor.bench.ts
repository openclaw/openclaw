/**
 * Performance Benchmarks for LLM Response Extraction
 *
 * Verifies that extraction meets the <100ms performance target for typical inputs.
 * Performance requirements:
 * - Simple responses: <10ms
 * - Long responses (5KB): <50ms
 * - Heavy noise filtering: <100ms
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LLMResponseExtractor } from "../extractor.js";
import { ConfigLoader } from "../config-loader.js";

describe("Extraction Performance Benchmarks", () => {
  let extractor: LLMResponseExtractor;

  beforeEach(() => {
    const config = ConfigLoader.load("claude-code");
    extractor = new LLMResponseExtractor(config);
  });

  describe("Simple Response Performance", () => {
    it("should extract simple response in <10ms", () => {
      const simpleOutput = `⏺ Hello world\n> `;

      const result = extractor.extract(simpleOutput);

      expect(result.response).toBe("Hello world");
      expect(result.metrics.extractionTimeMs).toBeLessThan(10);
      expect(result.metrics.responseFound).toBe(true);
    });

    it("should extract multi-line response in <10ms", () => {
      const multiLineOutput = `⏺ Line one
Line two
Line three
> `;

      const result = extractor.extract(multiLineOutput);

      expect(result.response).toBe("Line one\nLine two\nLine three");
      expect(result.metrics.extractionTimeMs).toBeLessThan(10);
    });
  });

  describe("Long Response Performance", () => {
    it("should extract 1KB response in <25ms", () => {
      // Generate 1KB of content (approximately 1000 chars)
      const content = "a".repeat(1000);
      const longOutput = `⏺ ${content}\n> `;

      const result = extractor.extract(longOutput);

      expect(result.response).toBe(content);
      expect(result.metrics.extractionTimeMs).toBeLessThan(25);
      expect(result.metrics.responseLength).toBeGreaterThanOrEqual(1000);
    });

    it("should extract 5KB response in <50ms", () => {
      // Generate 5KB of content (approximately 5000 chars)
      const content = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(90);
      const longOutput = `⏺ ${content}\n> `;

      const result = extractor.extract(longOutput);

      expect(result.response).toBe(content.trim());
      expect(result.metrics.extractionTimeMs).toBeLessThan(50);
      expect(result.metrics.responseLength).toBeGreaterThanOrEqual(5000);
    });

    it("should extract 10KB response in <100ms", () => {
      // Generate 10KB of content (approximately 10000 chars)
      const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(10);
      const content = (paragraph + "\n\n").repeat(50);
      const longOutput = `⏺ ${content}\n> `;

      const result = extractor.extract(longOutput);

      expect(result.response?.length).toBeGreaterThanOrEqual(9000);
      expect(result.metrics.extractionTimeMs).toBeLessThan(100);
      expect(result.metrics.responseLength).toBeGreaterThanOrEqual(9000);
    });
  });

  describe("Heavy Noise Filtering Performance", () => {
    it("should handle response with many noise lines in <50ms", () => {
      // Create output with many noise lines to filter
      const noiseLines = [
        "⏺ Actual response line 1",
        "Actual response line 2",
        "🔍 Searching...",
        "Actual response line 3",
        "⚡ Processing...",
        "Actual response line 4",
        "✓ Done",
        "Actual response line 5",
        "> ",
      ].join("\n");

      const result = extractor.extract(noiseLines);

      expect(result.response).toBeTruthy();
      expect(result.metrics.extractionTimeMs).toBeLessThan(50);
      expect(result.metrics.noiseLinesFiltered).toBeGreaterThan(0);
    });

    it("should handle complex output with separators and blocks in <100ms", () => {
      // Simulate complex Codex-style output with command blocks
      const complexOutput = `⏺ Here's the analysis:

First paragraph of analysis.

─────────────────────────
│ command output here    │
│ more output            │
└────────────────────────

Second paragraph after command block.

Third paragraph with more content.

> `;

      const result = extractor.extract(complexOutput);

      expect(result.response).toBeTruthy();
      expect(result.metrics.extractionTimeMs).toBeLessThan(100);
      expect(result.metrics.noiseLinesFiltered).toBeGreaterThan(0);
    });

    it("should handle 100+ line output with heavy filtering in <100ms", () => {
      // Generate large output with mixed content and noise
      const lines = ["⏺ Response starts here"];

      for (let i = 0; i < 50; i++) {
        lines.push(`Content line ${i}`);
        if (i % 5 === 0) {
          lines.push("🔍 Status update"); // Noise line
        }
      }

      lines.push("> ");
      const largeOutput = lines.join("\n");

      const result = extractor.extract(largeOutput);

      expect(result.response).toBeTruthy();
      expect(result.metrics.extractionTimeMs).toBeLessThan(100);
      expect(result.metrics.linesExtracted).toBeGreaterThan(50);
    });
  });

  describe("Edge Case Performance", () => {
    it("should handle empty output quickly (<5ms)", () => {
      const emptyOutput = "";

      const result = extractor.extract(emptyOutput);

      expect(result.response).toBeNull();
      expect(result.metrics.extractionTimeMs).toBeLessThan(5);
    });

    it("should handle output with no marker quickly (<5ms)", () => {
      const noMarkerOutput = "Just some random text without marker\nMore text\n> ";

      const result = extractor.extract(noMarkerOutput);

      expect(result.response).toBeNull();
      expect(result.metrics.extractionTimeMs).toBeLessThan(5);
    });

    it("should handle very long single line in <50ms", () => {
      // Single very long line (edge case for line-based processing)
      const longLine = "a".repeat(10000);
      const output = `⏺ ${longLine}\n> `;

      const result = extractor.extract(output);

      expect(result.response).toBe(longLine);
      expect(result.metrics.extractionTimeMs).toBeLessThan(50);
    });
  });

  describe("Batch Processing Performance", () => {
    it("should maintain performance across multiple extractions", () => {
      const outputs = ["⏺ Response 1\n> ", "⏺ Response 2\n> ", "⏺ Response 3\n> "];

      const times: number[] = [];

      for (const output of outputs) {
        const result = extractor.extract(output);
        times.push(result.metrics.extractionTimeMs);
      }

      // All extractions should be fast
      times.forEach((time) => {
        expect(time).toBeLessThan(10);
      });

      // Average should be well under target
      const avgTime = times.reduce((sum, t) => sum + t, 0) / times.length;
      expect(avgTime).toBeLessThan(5);
    });

    it("should handle rapid successive extractions efficiently", () => {
      const output = "⏺ Test response\n> ";
      const iterations = 50;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        const result = extractor.extract(output);
        expect(result.response).toBe("Test response");
      }

      const totalTime = Date.now() - startTime;
      const avgTimePerExtraction = totalTime / iterations;

      // Average time per extraction should be under 2ms for cached patterns
      expect(avgTimePerExtraction).toBeLessThan(2);

      // Total time for 50 extractions should be under 100ms
      expect(totalTime).toBeLessThan(100);
    });
  });

  describe("Performance Regression Tests", () => {
    it("should not degrade with different LLM configs", () => {
      const codexConfig = ConfigLoader.load("codex");
      const codexExtractor = new LLMResponseExtractor(codexConfig);

      const output = "⏺ Test response\n> ";

      const result = codexExtractor.extract(output);

      expect(result.response).toBe("Test response");
      expect(result.metrics.extractionTimeMs).toBeLessThan(10);
    });

    it("should handle worst-case input efficiently", () => {
      // Worst case: long output, many markers (extract last), heavy noise
      const lines = ["Previous response that should be ignored", "> "];

      // Add noise before target response
      for (let i = 0; i < 20; i++) {
        lines.push("🔍 Noise line " + i);
      }

      // Add actual response with noise mixed in
      lines.push("⏺ Target response line 1");
      for (let i = 0; i < 30; i++) {
        lines.push(`Content line ${i}`);
        if (i % 3 === 0) {
          lines.push("⚡ Status");
        }
      }
      lines.push("> ");

      const worstCaseOutput = lines.join("\n");

      const result = codexExtractor.extract(worstCaseOutput);

      expect(result.response).toBeTruthy();
      expect(result.metrics.extractionTimeMs).toBeLessThan(100);
    });
  });
});

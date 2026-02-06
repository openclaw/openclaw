/**
 * Performance Benchmark Tests
 *
 * Verify extraction meets <100ms performance target for typical input sizes
 */

import { describe, it, expect } from "vitest";
import { LLMResponseExtractor } from "../extractor.js";
import { ConfigLoader } from "../config-loader.js";

describe("Extraction Performance", () => {
  const claudeCodeConfig = ConfigLoader.load("claude-code");
  const codexConfig = ConfigLoader.load("codex");

  /**
   * Generate synthetic terminal output of specified size
   */
  function generateTerminalOutput(marker: string, sizeKB: number): string {
    const lines: string[] = [];
    const targetBytes = sizeKB * 1024;

    // Add some prompts and noise
    lines.push("> previous command");
    lines.push("some output here");
    lines.push("───────────────────");

    // Add response marker
    lines.push(`${marker} This is a response.`);

    // Pad to target size
    let currentSize = lines.join("\n").length;
    while (currentSize < targetBytes) {
      lines.push("This is additional response content that makes the output larger.");
      lines.push("");
      lines.push("Another paragraph of content to reach the target size.");
      currentSize = lines.join("\n").length;
    }

    return lines.join("\n");
  }

  it("should extract from 1KB input in <100ms (Claude Code)", () => {
    const extractor = new LLMResponseExtractor(claudeCodeConfig);
    const input = generateTerminalOutput("⏺", 1);

    const startTime = performance.now();
    const result = extractor.extract(input);
    const duration = performance.now() - startTime;

    expect(result.response).toBeTruthy();
    expect(duration).toBeLessThan(100);
    expect(result.metrics.extractionTimeMs).toBeLessThan(100);
  });

  it("should extract from 5KB input in <100ms (Claude Code)", () => {
    const extractor = new LLMResponseExtractor(claudeCodeConfig);
    const input = generateTerminalOutput("⏺", 5);

    const startTime = performance.now();
    const result = extractor.extract(input);
    const duration = performance.now() - startTime;

    expect(result.response).toBeTruthy();
    expect(duration).toBeLessThan(100);
    expect(result.metrics.extractionTimeMs).toBeLessThan(100);
  });

  it("should extract from 10KB input in <100ms (Claude Code)", () => {
    const extractor = new LLMResponseExtractor(claudeCodeConfig);
    const input = generateTerminalOutput("⏺", 10);

    const startTime = performance.now();
    const result = extractor.extract(input);
    const duration = performance.now() - startTime;

    expect(result.response).toBeTruthy();
    expect(duration).toBeLessThan(100);
    expect(result.metrics.extractionTimeMs).toBeLessThan(100);
  });

  it("should extract from 1KB input in <100ms (Codex)", () => {
    const extractor = new LLMResponseExtractor(codexConfig);
    const input = generateTerminalOutput("•", 1);

    const startTime = performance.now();
    const result = extractor.extract(input);
    const duration = performance.now() - startTime;

    expect(result.response).toBeTruthy();
    expect(duration).toBeLessThan(100);
    expect(result.metrics.extractionTimeMs).toBeLessThan(100);
  });

  it("should extract from 5KB input in <100ms (Codex)", () => {
    const extractor = new LLMResponseExtractor(codexConfig);
    const input = generateTerminalOutput("•", 5);

    const startTime = performance.now();
    const result = extractor.extract(input);
    const duration = performance.now() - startTime;

    expect(result.response).toBeTruthy();
    expect(duration).toBeLessThan(100);
    expect(result.metrics.extractionTimeMs).toBeLessThan(100);
  });

  it("should extract from 10KB input in <100ms (Codex)", () => {
    const extractor = new LLMResponseExtractor(codexConfig);
    const input = generateTerminalOutput("•", 10);

    const startTime = performance.now();
    const result = extractor.extract(input);
    const duration = performance.now() - startTime;

    expect(result.response).toBeTruthy();
    expect(duration).toBeLessThan(100);
    expect(result.metrics.extractionTimeMs).toBeLessThan(100);
  });

  it("should benefit from config caching (verify cached performance)", () => {
    // This tests that loading the same config multiple times is fast
    const iterations = 100;

    const startTime = performance.now();
    for (let i = 0; i < iterations; i++) {
      ConfigLoader.load("claude-code");
    }
    const duration = performance.now() - startTime;

    // 100 config loads should be <10ms total (caching working)
    expect(duration).toBeLessThan(10);
  });
});

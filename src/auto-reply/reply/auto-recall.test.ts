import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../memory/types.js";
import { formatMemoryRecallBlock, shouldTriggerMemoryRecall } from "./auto-recall.js";

describe("auto-recall", () => {
  describe("shouldTriggerMemoryRecall", () => {
    it("returns false for empty messages", () => {
      expect(
        shouldTriggerMemoryRecall({ message: "   ", mode: "heuristic", minMessageChars: 0 }),
      ).toBe(false);
    });

    it("does not trigger for short messages", () => {
      expect(
        shouldTriggerMemoryRecall({ message: "did we", mode: "heuristic", minMessageChars: 20 }),
      ).toBe(false);
    });

    it("skips slash commands", () => {
      expect(
        shouldTriggerMemoryRecall({ message: "/new", mode: "heuristic", minMessageChars: 0 }),
      ).toBe(false);
    });

    it("triggers for continuity phrasing", () => {
      expect(
        shouldTriggerMemoryRecall({
          message: "did we finish the daily synthesis?",
          mode: "heuristic",
          minMessageChars: 0,
        }),
      ).toBe(true);
    });

    it("always triggers when mode=always (except empty)", () => {
      expect(
        shouldTriggerMemoryRecall({
          message: "hello",
          mode: "always",
          minMessageChars: 0,
        }),
      ).toBe(true);
    });
  });

  describe("formatMemoryRecallBlock", () => {
    const results: MemorySearchResult[] = [
      {
        path: "memory/daily/2026-02-07.md",
        startLine: 10,
        endLine: 12,
        score: 0.9,
        snippet: "A relevant memory snippet.",
        source: "memory",
        citation: undefined,
      },
      {
        path: "memory/atoms/atom-1.md",
        startLine: 1,
        endLine: 1,
        score: 0.8,
        snippet: "Another snippet.",
        source: "memory",
        citation: undefined,
      },
    ];

    it("includes citations when enabled", () => {
      const text = formatMemoryRecallBlock({
        results,
        includeCitations: true,
        maxChars: 10_000,
      });
      expect(text).toContain("## Auto-recall");
      expect(text).toContain("Source: memory/daily/2026-02-07.md#L10-L12");
    });

    it("omits citations when disabled", () => {
      const text = formatMemoryRecallBlock({
        results,
        includeCitations: false,
        maxChars: 10_000,
      });
      expect(text).toContain("## Auto-recall");
      expect(text).not.toContain("Source:");
    });

    it("respects the maxChars budget", () => {
      const text = formatMemoryRecallBlock({
        results,
        includeCitations: true,
        maxChars: 60,
      });
      expect(text.length).toBeLessThanOrEqual(60);
    });
  });
});

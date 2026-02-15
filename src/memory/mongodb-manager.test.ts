import { describe, it, expect } from "vitest";
import type { MemorySearchResult } from "./types.js";
import { deduplicateSearchResults } from "./mongodb-manager.js";

// ---------------------------------------------------------------------------
// Phase 3: Result dedup at merge by content hash
// ---------------------------------------------------------------------------

describe("deduplicateSearchResults", () => {
  it("removes duplicate results by content, keeping the highest-scoring one", () => {
    const results: MemorySearchResult[] = [
      { filePath: "/a.md", snippet: "same content here", score: 0.9, source: "memory" },
      { filePath: "/b.md", snippet: "same content here", score: 0.7, source: "kb" },
      { filePath: "/c.md", snippet: "different content", score: 0.8, source: "sessions" },
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(2);
    // The duplicate "same content here" should keep the one with score 0.9
    const sameContentResult = deduped.find((r) => r.snippet === "same content here");
    expect(sameContentResult?.score).toBe(0.9);
    expect(sameContentResult?.filePath).toBe("/a.md");
  });

  it("returns empty array for empty input", () => {
    const deduped = deduplicateSearchResults([]);
    expect(deduped).toHaveLength(0);
  });

  it("keeps all results when no duplicates exist", () => {
    const results: MemorySearchResult[] = [
      { filePath: "/a.md", snippet: "first content", score: 0.9, source: "memory" },
      { filePath: "/b.md", snippet: "second content", score: 0.7, source: "kb" },
      { filePath: "/c.md", snippet: "third content", score: 0.5, source: "sessions" },
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(3);
  });

  it("handles multiple duplicates correctly", () => {
    const results: MemorySearchResult[] = [
      { filePath: "/a.md", snippet: "alpha content", score: 0.3, source: "memory" },
      { filePath: "/b.md", snippet: "alpha content", score: 0.9, source: "kb" },
      { filePath: "/c.md", snippet: "alpha content", score: 0.5, source: "structured" },
      { filePath: "/d.md", snippet: "beta content", score: 0.8, source: "memory" },
      { filePath: "/e.md", snippet: "beta content", score: 0.6, source: "sessions" },
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(2);
    const alpha = deduped.find((r) => r.snippet === "alpha content");
    expect(alpha?.score).toBe(0.9);
    const beta = deduped.find((r) => r.snippet === "beta content");
    expect(beta?.score).toBe(0.8);
  });

  it("returns dedupCount in the result when logging is needed", () => {
    const results: MemorySearchResult[] = [
      { filePath: "/a.md", snippet: "dup content", score: 0.9, source: "memory" },
      { filePath: "/b.md", snippet: "dup content", score: 0.7, source: "kb" },
    ];

    // The function should return deduped results — the count of removed duplicates
    // can be derived from input.length - output.length
    const deduped = deduplicateSearchResults(results);
    const dedupCount = results.length - deduped.length;
    expect(dedupCount).toBe(1);
  });
});

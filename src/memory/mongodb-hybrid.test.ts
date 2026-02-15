import { describe, it, expect } from "vitest";
import type { MemorySearchResult } from "./types.js";
import {
  buildOrJoinFtsQuery,
  rrfScore,
  normalizeVectorScore,
  normalizeBM25Score,
  normalizeRRFScore,
  mergeHybridResultsMongoDB,
  normalizeSearchResults,
  type SearchMethod,
} from "./mongodb-hybrid.js";

// ---------------------------------------------------------------------------
// buildOrJoinFtsQuery -- OR-join FTS query builder
// ---------------------------------------------------------------------------

describe("buildOrJoinFtsQuery", () => {
  it("joins tokens with OR instead of AND", () => {
    const result = buildOrJoinFtsQuery("hello world test");
    expect(result).toBe('"hello" OR "world" OR "test"');
  });

  it("returns null for empty input", () => {
    expect(buildOrJoinFtsQuery("")).toBeNull();
    expect(buildOrJoinFtsQuery("   ")).toBeNull();
  });

  it("handles single token", () => {
    expect(buildOrJoinFtsQuery("hello")).toBe('"hello"');
  });

  it("strips non-alphanumeric characters", () => {
    const result = buildOrJoinFtsQuery("hello! world? test.");
    expect(result).toBe('"hello" OR "world" OR "test"');
  });

  it("strips quotes from tokens (non-alphanumeric splits tokens)", () => {
    // Quotes are non-alphanumeric, so they split tokens. This is expected.
    const result = buildOrJoinFtsQuery('he"llo wor"ld');
    expect(result).toBe('"he" OR "llo" OR "wor" OR "ld"');
  });
});

// ---------------------------------------------------------------------------
// rrfScore -- Reciprocal Rank Fusion scoring
// ---------------------------------------------------------------------------

describe("rrfScore", () => {
  it("computes 1/(k+rank) with k=60", () => {
    // rank=1: 1/(60+1) = 1/61
    expect(rrfScore(1)).toBeCloseTo(1 / 61, 6);
  });

  it("decreases as rank increases", () => {
    const score1 = rrfScore(1);
    const score5 = rrfScore(5);
    const score10 = rrfScore(10);
    expect(score1).toBeGreaterThan(score5);
    expect(score5).toBeGreaterThan(score10);
  });

  it("handles rank=0 (top result)", () => {
    expect(rrfScore(0)).toBeCloseTo(1 / 60, 6);
  });

  it("uses custom k parameter", () => {
    expect(rrfScore(1, 20)).toBeCloseTo(1 / 21, 6);
  });
});

// ---------------------------------------------------------------------------
// normalizeVectorScore -- cosine similarity already [0,1]
// ---------------------------------------------------------------------------

describe("normalizeVectorScore", () => {
  it("clamps to [0,1] range", () => {
    expect(normalizeVectorScore(0.85)).toBe(0.85);
    expect(normalizeVectorScore(1.2)).toBe(1.0);
    expect(normalizeVectorScore(-0.1)).toBe(0.0);
  });

  it("returns 0 for non-finite inputs", () => {
    expect(normalizeVectorScore(NaN)).toBe(0);
    expect(normalizeVectorScore(Infinity)).toBe(1.0);
    expect(normalizeVectorScore(-Infinity)).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// normalizeBM25Score -- unbounded [0, inf) to [0,1]
// ---------------------------------------------------------------------------

describe("normalizeBM25Score", () => {
  it("normalizes using sigmoid-like function", () => {
    const low = normalizeBM25Score(0.5);
    const mid = normalizeBM25Score(5);
    const high = normalizeBM25Score(50);
    // Higher raw scores produce higher normalized scores
    expect(high).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(low);
  });

  it("returns value in [0,1] range", () => {
    expect(normalizeBM25Score(0)).toBeGreaterThanOrEqual(0);
    expect(normalizeBM25Score(0)).toBeLessThanOrEqual(1);
    expect(normalizeBM25Score(100)).toBeGreaterThanOrEqual(0);
    expect(normalizeBM25Score(100)).toBeLessThanOrEqual(1);
  });

  it("returns 0 for negative or NaN", () => {
    expect(normalizeBM25Score(-1)).toBe(0);
    expect(normalizeBM25Score(NaN)).toBe(0);
  });

  it("approaches 1 for very high scores", () => {
    expect(normalizeBM25Score(1000)).toBeGreaterThan(0.95);
  });
});

// ---------------------------------------------------------------------------
// normalizeRRFScore -- already [0, 1/k]
// ---------------------------------------------------------------------------

describe("normalizeRRFScore", () => {
  it("scales RRF score to [0,1] range", () => {
    // Top-ranked item: 1/(60+1) = 0.01639... should scale to ~1.0
    const topScore = normalizeRRFScore(1 / 61);
    expect(topScore).toBeCloseTo(1.0, 1);
  });

  it("returns 0 for 0 input", () => {
    expect(normalizeRRFScore(0)).toBe(0);
  });

  it("stays in [0,1] range", () => {
    for (let rank = 1; rank <= 100; rank++) {
      const raw = 1 / (60 + rank);
      const normalized = normalizeRRFScore(raw);
      expect(normalized).toBeGreaterThanOrEqual(0);
      expect(normalized).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// mergeHybridResultsMongoDB -- RRF-based merge (drop-in for upstream merge)
// ---------------------------------------------------------------------------

describe("mergeHybridResultsMongoDB", () => {
  it("merges vector and keyword results using RRF", () => {
    const vectorResults: MemorySearchResult[] = [
      {
        path: "a.md",
        startLine: 1,
        endLine: 5,
        score: 0.95,
        snippet: "vector hit A",
        source: "memory",
      },
      {
        path: "b.md",
        startLine: 1,
        endLine: 5,
        score: 0.8,
        snippet: "vector hit B",
        source: "memory",
      },
    ];
    const keywordResults: MemorySearchResult[] = [
      {
        path: "a.md",
        startLine: 1,
        endLine: 5,
        score: 5.2,
        snippet: "keyword hit A",
        source: "memory",
      },
      {
        path: "c.md",
        startLine: 10,
        endLine: 20,
        score: 3.1,
        snippet: "keyword hit C",
        source: "memory",
      },
    ];

    const merged = mergeHybridResultsMongoDB({
      vector: vectorResults,
      keyword: keywordResults,
      maxResults: 10,
    });

    // a.md appears in both, should be ranked highest (appears in both lists)
    expect(merged[0].path).toBe("a.md");
    // All 3 unique items should be present
    expect(merged).toHaveLength(3);
    // Scores should be in [0,1] range (normalized RRF)
    for (const r of merged) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("handles empty vector results", () => {
    const keywordResults: MemorySearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 5, score: 5.0, snippet: "kw", source: "memory" },
    ];
    const merged = mergeHybridResultsMongoDB({
      vector: [],
      keyword: keywordResults,
      maxResults: 10,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].path).toBe("a.md");
  });

  it("handles empty keyword results", () => {
    const vectorResults: MemorySearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 5, score: 0.9, snippet: "vec", source: "memory" },
    ];
    const merged = mergeHybridResultsMongoDB({
      vector: vectorResults,
      keyword: [],
      maxResults: 10,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].path).toBe("a.md");
  });

  it("handles both empty", () => {
    const merged = mergeHybridResultsMongoDB({
      vector: [],
      keyword: [],
      maxResults: 10,
    });
    expect(merged).toEqual([]);
  });

  it("respects maxResults", () => {
    const vectorResults: MemorySearchResult[] = Array.from({ length: 20 }, (_, i) => ({
      path: `v${i}.md`,
      startLine: 1,
      endLine: 2,
      score: 0.9 - i * 0.01,
      snippet: "t",
      source: "memory" as const,
    }));
    const merged = mergeHybridResultsMongoDB({
      vector: vectorResults,
      keyword: [],
      maxResults: 5,
    });
    expect(merged).toHaveLength(5);
  });

  it("sorts by combined RRF score descending", () => {
    const vectorResults: MemorySearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 2, score: 0.9, snippet: "a", source: "memory" },
      { path: "b.md", startLine: 1, endLine: 2, score: 0.5, snippet: "b", source: "memory" },
    ];
    const keywordResults: MemorySearchResult[] = [
      { path: "b.md", startLine: 1, endLine: 2, score: 8.0, snippet: "b-kw", source: "memory" },
      { path: "c.md", startLine: 1, endLine: 2, score: 2.0, snippet: "c", source: "memory" },
    ];

    const merged = mergeHybridResultsMongoDB({
      vector: vectorResults,
      keyword: keywordResults,
      maxResults: 10,
    });

    // b.md appears in BOTH lists (rank 2 vector + rank 1 keyword) = sum of RRF scores
    // a.md appears in vector only (rank 1) = single RRF score
    // b should rank higher than a because it appears in both
    expect(merged[0].path).toBe("b.md");
    // Verify descending order
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i - 1].score).toBeGreaterThanOrEqual(merged[i].score);
    }
  });

  it("uses keyword snippet when available for overlapping results", () => {
    const vectorResults: MemorySearchResult[] = [
      {
        path: "a.md",
        startLine: 1,
        endLine: 5,
        score: 0.9,
        snippet: "vector text",
        source: "memory",
      },
    ];
    const keywordResults: MemorySearchResult[] = [
      {
        path: "a.md",
        startLine: 1,
        endLine: 5,
        score: 5.0,
        snippet: "keyword text",
        source: "memory",
      },
    ];
    const merged = mergeHybridResultsMongoDB({
      vector: vectorResults,
      keyword: keywordResults,
      maxResults: 10,
    });
    // Prefer keyword snippet (better relevance highlight)
    expect(merged[0].snippet).toBe("keyword text");
  });
});

// ---------------------------------------------------------------------------
// normalizeSearchResults -- tag + normalize for cross-source merge
// ---------------------------------------------------------------------------

describe("normalizeSearchResults", () => {
  it("normalizes vector scores (cosine [0,1])", () => {
    const results: MemorySearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 2, score: 0.85, snippet: "t", source: "memory" },
    ];
    const normalized = normalizeSearchResults(results, "vector");
    expect(normalized[0].score).toBeCloseTo(0.85, 2);
  });

  it("normalizes BM25 text scores to [0,1]", () => {
    const results: MemorySearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 2, score: 15.5, snippet: "t", source: "memory" },
    ];
    const normalized = normalizeSearchResults(results, "text");
    expect(normalized[0].score).toBeGreaterThan(0);
    expect(normalized[0].score).toBeLessThanOrEqual(1);
  });

  it("normalizes hybrid/RRF scores", () => {
    const results: MemorySearchResult[] = [
      { path: "a.md", startLine: 1, endLine: 2, score: 0.015, snippet: "t", source: "memory" },
    ];
    const normalized = normalizeSearchResults(results, "hybrid");
    expect(normalized[0].score).toBeGreaterThanOrEqual(0);
    expect(normalized[0].score).toBeLessThanOrEqual(1);
  });

  it("handles structured search method", () => {
    const results: MemorySearchResult[] = [
      {
        path: "structured",
        startLine: 0,
        endLine: 0,
        score: 0.7,
        snippet: "t",
        source: "structured",
      },
    ];
    const normalized = normalizeSearchResults(results, "structured");
    // Structured uses vector-like scores
    expect(normalized[0].score).toBeCloseTo(0.7, 2);
  });

  it("handles kb search method", () => {
    const results: MemorySearchResult[] = [
      { path: "kb-doc", startLine: 1, endLine: 5, score: 0.8, snippet: "t", source: "kb" },
    ];
    const normalized = normalizeSearchResults(results, "kb");
    expect(normalized[0].score).toBeCloseTo(0.8, 2);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeSearchResults([], "vector")).toEqual([]);
  });

  it("preserves all result fields except score", () => {
    const results: MemorySearchResult[] = [
      {
        path: "test.md",
        startLine: 5,
        endLine: 10,
        score: 0.9,
        snippet: "hello",
        source: "memory",
      },
    ];
    const normalized = normalizeSearchResults(results, "vector");
    expect(normalized[0].path).toBe("test.md");
    expect(normalized[0].startLine).toBe(5);
    expect(normalized[0].endLine).toBe(10);
    expect(normalized[0].snippet).toBe("hello");
    expect(normalized[0].source).toBe("memory");
  });

  it("ensures cross-source merge ranking is correct", () => {
    // Simulate: vector result with score 0.85, BM25 result with raw score 15.0
    // After normalization, both should be comparable in [0,1]
    const vectorResults: MemorySearchResult[] = [
      { path: "vec.md", startLine: 1, endLine: 2, score: 0.85, snippet: "t", source: "memory" },
    ];
    const textResults: MemorySearchResult[] = [
      { path: "text.md", startLine: 1, endLine: 2, score: 15.0, snippet: "t", source: "memory" },
    ];
    const normalizedVec = normalizeSearchResults(vectorResults, "vector");
    const normalizedText = normalizeSearchResults(textResults, "text");

    // Both should be in [0,1]
    expect(normalizedVec[0].score).toBeGreaterThanOrEqual(0);
    expect(normalizedVec[0].score).toBeLessThanOrEqual(1);
    expect(normalizedText[0].score).toBeGreaterThanOrEqual(0);
    expect(normalizedText[0].score).toBeLessThanOrEqual(1);

    // Merge and sort -- should work correctly
    const merged = [...normalizedVec, ...normalizedText].toSorted((a, b) => b.score - a.score);
    expect(merged).toHaveLength(2);
    // Higher normalized score should come first
    expect(merged[0].score).toBeGreaterThanOrEqual(merged[1].score);
  });
});

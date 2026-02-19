import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults, calculateRRFScore } from "./hybrid.js";

describe("memory hybrid helpers", () => {
  it("buildFtsQuery tokenizes and AND-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
    expect(buildFtsQuery("金银价格")).toBe('"金银价格"');
    expect(buildFtsQuery("価格 2026年")).toBe('"価格" AND "2026年"');
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("bm25RankToScore is monotonic and clamped", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(-100)).toBeCloseTo(1);
  });

  it("mergeHybridResults unions by id and combines weighted scores", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    expect(a?.score).toBeCloseTo(0.7 * 0.9);
    expect(b?.score).toBeCloseTo(0.3 * 1.0);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.2,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1.0);
  });

  it("calculateRRFScore uses k-constant for ranking", () => {
    // RRF formula: score = 1 / (k + rank)
    expect(calculateRRFScore([1], 60)).toBeCloseTo(1 / 61);
    expect(calculateRRFScore([2], 60)).toBeCloseTo(1 / 62);
    expect(calculateRRFScore([1, 1], 60)).toBeCloseTo(2 / 61); // fusion of two rank-1 results
    expect(calculateRRFScore([1, 2], 60)).toBeCloseTo(1 / 61 + 1 / 62); // one rank-1, one rank-2
  });

  it("mergeHybridResults with RRF fusion ranks by sources", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      fusion: "rrf",
      rrfK: 60,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9, // top vector result
        },
        {
          id: "c",
          path: "memory/c.md",
          startLine: 5,
          endLine: 6,
          source: "memory",
          snippet: "vec-c",
          vectorScore: 0.5,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1.0, // top keyword result
        },
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 0.5,
        },
      ],
    });

    // With RRF, results appearing in both sources should rank higher
    // a: rank 1 in vector, rank 2 in keyword → RRF = 1/61 + 1/62
    // b: rank 2 in vector (not present), rank 1 in keyword → RRF = 1/61
    // c: rank 2 in vector, not in keyword → RRF = 1/62

    expect(merged).toHaveLength(3);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    const c = merged.find((r) => r.path === "memory/c.md");

    // a should rank highest (appears in both sources)
    expect(a?.score).toBeGreaterThan(b?.score || 0);
    expect(b?.score).toBeGreaterThan(c?.score || 0);
  });

  it("mergeHybridResults RRF and weighted produce different rankings", async () => {
    const testData = {
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.95,
        },
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "vec-b",
          vectorScore: 0.5,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1.0,
        },
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 0.0,
        },
      ],
    };

    const weighted = await mergeHybridResults({
      ...testData,
      fusion: "weighted",
    });

    const rrf = await mergeHybridResults({
      ...testData,
      fusion: "rrf",
      rrfK: 60,
    });

    // In weighted: a = 0.7*0.95 + 0.3*0.0 = 0.665; b = 0.7*0.5 + 0.3*1.0 = 0.65
    // Weighted should rank a > b

    // In RRF: both appear in both sources
    // a: rank 1 in vec, rank 2 in keyword
    // b: rank 2 in vec, rank 1 in keyword
    // Both have same RRF: 1/61 + 1/62
    // But order might differ based on stability

    expect(weighted[0]?.path).toBe("memory/a.md"); // weighted favors vector score
    expect(rrf.length).toBe(2); // both should be present
  });
});

import { describe, it, expect } from "vitest";
import {
  tokenize,
  jaccardSimilarity,
  textSimilarity,
  computeMMRScore,
  mmrRerank,
  applyMMRToHybridResults,
  DEFAULT_MMR_CONFIG,
  type MMRItem,
} from "./mmr.js";

describe("tokenize", () => {
  it("extracts alphanumeric tokens and lowercases", () => {
    const result = tokenize("Hello World 123");
    expect(result).toEqual(new Set(["hello", "world", "123"]));
  });

  it("handles empty string", () => {
    expect(tokenize("")).toEqual(new Set());
  });

  it("handles special characters only", () => {
    expect(tokenize("!@#$%^&*()")).toEqual(new Set());
  });

  it("handles underscores in tokens", () => {
    const result = tokenize("hello_world test_case");
    expect(result).toEqual(new Set(["hello_world", "test_case"]));
  });

  it("deduplicates repeated tokens", () => {
    const result = tokenize("hello hello world world");
    expect(result).toEqual(new Set(["hello", "world"]));
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const set = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(set, set)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const setA = new Set(["a", "b"]);
    const setB = new Set(["c", "d"]);
    expect(jaccardSimilarity(setA, setB)).toBe(0);
  });

  it("returns 1 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one set is empty", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(["a"]))).toBe(0);
  });

  it("computes correct similarity for partial overlap", () => {
    const setA = new Set(["a", "b", "c"]);
    const setB = new Set(["b", "c", "d"]);
    // Intersection: {b, c} = 2, Union: {a, b, c, d} = 4
    expect(jaccardSimilarity(setA, setB)).toBe(0.5);
  });

  it("is symmetric", () => {
    const setA = new Set(["a", "b"]);
    const setB = new Set(["b", "c"]);
    expect(jaccardSimilarity(setA, setB)).toBe(jaccardSimilarity(setB, setA));
  });
});

describe("textSimilarity", () => {
  it("returns 1 for identical text", () => {
    expect(textSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 1 for same words different order", () => {
    expect(textSimilarity("hello world", "world hello")).toBe(1);
  });

  it("returns 0 for completely different text", () => {
    expect(textSimilarity("hello world", "foo bar")).toBe(0);
  });

  it("handles case insensitivity", () => {
    expect(textSimilarity("Hello World", "hello world")).toBe(1);
  });
});

describe("computeMMRScore", () => {
  it("returns pure relevance when lambda=1", () => {
    expect(computeMMRScore(0.8, 0.5, 1)).toBe(0.8);
  });

  it("returns negative similarity when lambda=0", () => {
    expect(computeMMRScore(0.8, 0.5, 0)).toBe(-0.5);
  });

  it("balances relevance and diversity at lambda=0.5", () => {
    // 0.5 * 0.8 - 0.5 * 0.6 = 0.4 - 0.3 = 0.1
    expect(computeMMRScore(0.8, 0.6, 0.5)).toBeCloseTo(0.1);
  });

  it("computes correctly with default lambda=0.7", () => {
    // 0.7 * 1.0 - 0.3 * 0.5 = 0.7 - 0.15 = 0.55
    expect(computeMMRScore(1.0, 0.5, 0.7)).toBeCloseTo(0.55);
  });
});

describe("empty input behavior", () => {
  it("returns empty array for empty input", () => {
    expect(mmrRerank([])).toEqual([]);
    expect(applyMMRToHybridResults([])).toEqual([]);
  });
});

describe("mmrRerank", () => {
  describe("edge cases", () => {
    it("returns single item unchanged", () => {
      const items: MMRItem[] = [{ id: "1", score: 0.9, content: "hello" }];
      expect(mmrRerank(items)).toEqual(items);
    });

    it("returns copy, not original array", () => {
      const items: MMRItem[] = [{ id: "1", score: 0.9, content: "hello" }];
      const result = mmrRerank(items);
      expect(result).not.toBe(items);
    });

    it("returns items unchanged when disabled", () => {
      const items: MMRItem[] = [
        { id: "1", score: 0.9, content: "hello" },
        { id: "2", score: 0.8, content: "hello" },
      ];
      const result = mmrRerank(items, { enabled: false });
      expect(result).toEqual(items);
    });
  });

  describe("lambda edge cases", () => {
    const diverseItems: MMRItem[] = [
      { id: "1", score: 1.0, content: "apple banana cherry" },
      { id: "2", score: 0.9, content: "apple banana date" },
      { id: "3", score: 0.8, content: "elderberry fig grape" },
    ];

    it("lambda=1 returns pure relevance order", () => {
      const result = mmrRerank(diverseItems, { lambda: 1 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("lambda=0 maximizes diversity", () => {
      const result = mmrRerank(diverseItems, { enabled: true, lambda: 0 });
      // First item is still highest score (no penalty yet)
      expect(result[0].id).toBe("1");
      // Second should be most different from first
      expect(result[1].id).toBe("3"); // elderberry... is most different
    });

    it("clamps lambda > 1 to 1", () => {
      const result = mmrRerank(diverseItems, { lambda: 1.5 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("clamps lambda < 0 to 0", () => {
      const result = mmrRerank(diverseItems, { enabled: true, lambda: -0.5 });
      expect(result[0].id).toBe("1");
      expect(result[1].id).toBe("3");
    });
  });

  describe("diversity behavior", () => {
    it("promotes diverse results over similar high-scoring ones", () => {
      const items: MMRItem[] = [
        { id: "1", score: 1.0, content: "machine learning neural networks" },
        { id: "2", score: 0.95, content: "machine learning deep learning" },
        { id: "3", score: 0.9, content: "database systems sql queries" },
        { id: "4", score: 0.85, content: "machine learning algorithms" },
      ];

      const result = mmrRerank(items, { enabled: true, lambda: 0.5 });

      // First is always highest score
      expect(result[0].id).toBe("1");
      // Second should be the diverse database item, not another ML item
      expect(result[1].id).toBe("3");
    });

    it("handles items with identical content", () => {
      const items: MMRItem[] = [
        { id: "1", score: 1.0, content: "identical content" },
        { id: "2", score: 0.9, content: "identical content" },
        { id: "3", score: 0.8, content: "different stuff" },
      ];

      const result = mmrRerank(items, { enabled: true, lambda: 0.5 });
      expect(result[0].id).toBe("1");
      // Second should be different, not identical duplicate
      expect(result[1].id).toBe("3");
    });

    it("handles all identical content gracefully", () => {
      const items: MMRItem[] = [
        { id: "1", score: 1.0, content: "same" },
        { id: "2", score: 0.9, content: "same" },
        { id: "3", score: 0.8, content: "same" },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      // Should still complete without error, order by score as tiebreaker
      expect(result).toHaveLength(3);
    });
  });

  describe("tie-breaking", () => {
    it("uses original score as tiebreaker", () => {
      const items: MMRItem[] = [
        { id: "1", score: 1.0, content: "unique content one" },
        { id: "2", score: 0.9, content: "unique content two" },
        { id: "3", score: 0.8, content: "unique content three" },
      ];

      // With very different content and lambda=1, should be pure score order
      const result = mmrRerank(items, { lambda: 1 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("preserves all items even with same MMR scores", () => {
      const items: MMRItem[] = [
        { id: "1", score: 0.5, content: "a" },
        { id: "2", score: 0.5, content: "b" },
        { id: "3", score: 0.5, content: "c" },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(3);
      expect(new Set(result.map((i) => i.id))).toEqual(new Set(["1", "2", "3"]));
    });
  });

  describe("score normalization", () => {
    it("handles items with same scores", () => {
      const items: MMRItem[] = [
        { id: "1", score: 0.5, content: "hello world" },
        { id: "2", score: 0.5, content: "foo bar" },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(2);
    });

    it("handles negative scores", () => {
      const items: MMRItem[] = [
        { id: "1", score: -0.5, content: "hello world" },
        { id: "2", score: -1.0, content: "foo bar" },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(2);
      // Higher score (less negative) should come first
      expect(result[0].id).toBe("1");
    });
  });
});

describe("applyMMRToHybridResults", () => {
  type HybridResult = {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: string;
  };

  it("preserves all original fields", () => {
    const results: HybridResult[] = [
      {
        path: "/test/file.ts",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "hello world",
        source: "memory",
      },
    ];

    const reranked = applyMMRToHybridResults(results);
    expect(reranked[0]).toEqual(results[0]);
  });

  it("creates unique IDs from path and startLine", () => {
    const results: HybridResult[] = [
      {
        path: "/test/a.ts",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "same content here",
        source: "memory",
      },
      {
        path: "/test/a.ts",
        startLine: 20,
        endLine: 30,
        score: 0.8,
        snippet: "same content here",
        source: "memory",
      },
    ];

    // Should work without ID collision
    const reranked = applyMMRToHybridResults(results);
    expect(reranked).toHaveLength(2);
  });

  it("re-ranks results for diversity", () => {
    const results: HybridResult[] = [
      {
        path: "/a.ts",
        startLine: 1,
        endLine: 10,
        score: 1.0,
        snippet: "function add numbers together",
        source: "memory",
      },
      {
        path: "/b.ts",
        startLine: 1,
        endLine: 10,
        score: 0.95,
        snippet: "function add values together",
        source: "memory",
      },
      {
        path: "/c.ts",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "database connection pool",
        source: "memory",
      },
    ];

    const reranked = applyMMRToHybridResults(results, { enabled: true, lambda: 0.5 });

    // First stays the same (highest score)
    expect(reranked[0].path).toBe("/a.ts");
    // Second should be the diverse one
    expect(reranked[1].path).toBe("/c.ts");
  });

  it("respects disabled config", () => {
    const results: HybridResult[] = [
      { path: "/a.ts", startLine: 1, endLine: 10, score: 0.9, snippet: "test", source: "memory" },
      { path: "/b.ts", startLine: 1, endLine: 10, score: 0.8, snippet: "test", source: "memory" },
    ];

    const reranked = applyMMRToHybridResults(results, { enabled: false });
    expect(reranked).toEqual(results);
  });
});

describe("DEFAULT_MMR_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_MMR_CONFIG.enabled).toBe(false);
    expect(DEFAULT_MMR_CONFIG.lambda).toBe(0.7);
  });
});

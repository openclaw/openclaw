import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsOrQuery, buildFtsQuery, mergeHybridResults } from "./hybrid.js";

describe("memory hybrid helpers", () => {
  it("buildFtsQuery tokenizes and AND-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
    expect(buildFtsQuery("金银价格")).toBe('"金银价格"');
    expect(buildFtsQuery("価格 2026年")).toBe('"価格" AND "2026年"');
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("buildFtsOrQuery tokenizes and OR-joins", () => {
    expect(buildFtsOrQuery("hello world")).toBe('"hello" OR "world"');
    expect(buildFtsOrQuery("FOO_bar baz-1")).toBe('"FOO_bar" OR "baz" OR "1"');
    expect(buildFtsOrQuery("金银价格")).toBe('"金银价格"');
    expect(buildFtsOrQuery("価格 2026年")).toBe('"価格" OR "2026年"');
    expect(buildFtsOrQuery("   ")).toBeNull();
    // Single token: AND and OR produce the same result
    expect(buildFtsOrQuery("hello")).toBe(buildFtsQuery("hello"));
  });

  it("bm25RankToScore is monotonic and clamped", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(-100)).toBeCloseTo(1);
  });

  it("mergeHybridResults unions by id and combines weighted scores", () => {
    const merged = mergeHybridResults({
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

  it("mergeHybridResults prefers keyword snippet when ids overlap", () => {
    const merged = mergeHybridResults({
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
});

describe("searchKeyword OR fallback", () => {
  it("returns OR-fallback results when AND query hits nothing", async () => {
    const { searchKeyword } = await import("./manager-search.js");

    const fakeRow = {
      id: "x1",
      path: "MEMORY.md",
      source: "memory",
      start_line: 1,
      end_line: 5,
      text: "Kit school neuropsych evaluation",
      rank: -10,
    };

    // Stub: returns rows only for OR-join queries
    const stmt = { all: (q: string) => (q.includes(" OR ") ? [fakeRow] : []) };
    const db = { prepare: () => stmt } as unknown as import("node:sqlite").DatabaseSync;

    const results = await searchKeyword({
      db,
      ftsTable: "chunks_fts",
      providerModel: "text-embedding-3-small",
      query: "Kit school neuropsych evaluation",
      limit: 5,
      snippetMaxChars: 200,
      sourceFilter: { sql: "", params: [] },
      buildFtsQuery,
      buildFtsFallbackQuery: buildFtsOrQuery,
      bm25RankToScore,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("MEMORY.md");
  });

  it("does not use fallback when AND query returns results", async () => {
    const { searchKeyword } = await import("./manager-search.js");

    const andRow = {
      id: "a1",
      path: "memory/2026-02-20.md",
      source: "memory",
      start_line: 1,
      end_line: 3,
      text: "matched via AND",
      rank: -20,
    };

    // Stub: returns andRow for AND, nothing for OR
    const stmt = { all: (q: string) => (q.includes(" OR ") ? [] : [andRow]) };
    const db = { prepare: () => stmt } as unknown as import("node:sqlite").DatabaseSync;

    const results = await searchKeyword({
      db,
      ftsTable: "chunks_fts",
      providerModel: "text-embedding-3-small",
      query: "matched via AND",
      limit: 5,
      snippetMaxChars: 200,
      sourceFilter: { sql: "", params: [] },
      buildFtsQuery,
      buildFtsFallbackQuery: buildFtsOrQuery,
      bm25RankToScore,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("memory/2026-02-20.md");
  });
});

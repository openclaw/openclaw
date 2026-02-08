import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults, segmentCjk } from "./hybrid.js";

describe("memory hybrid helpers", () => {
  it("buildFtsQuery tokenizes and AND-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("buildFtsQuery handles CJK characters", () => {
    // Each CJK character becomes its own quoted token
    expect(buildFtsQuery("你好")).toBe('"你" AND "好"');
    expect(buildFtsQuery("搜索引擎")).toBe('"搜" AND "索" AND "引" AND "擎"');
  });

  it("buildFtsQuery handles mixed CJK and ASCII", () => {
    expect(buildFtsQuery("hello 世界")).toBe('"hello" AND "世" AND "界"');
    expect(buildFtsQuery("sqlite 测试")).toBe('"sqlite" AND "测" AND "试"');
  });

  it("buildFtsQuery returns null for CJK punctuation only", () => {
    // CJK punctuation (，。！) should not produce tokens
    expect(buildFtsQuery("，。！")).toBeNull();
  });

  it("segmentCjk adds spaces around CJK characters", () => {
    expect(segmentCjk("全文搜索")).toBe("全 文 搜 索");
    expect(segmentCjk("hello world")).toBe("hello world");
    expect(segmentCjk("hello世界test")).toBe("hello 世 界 test");
    expect(segmentCjk("")).toBe("");
  });

  it("segmentCjk handles Japanese kana", () => {
    expect(segmentCjk("テスト")).toBe("テ ス ト");
    expect(segmentCjk("ひらがな")).toBe("ひ ら が な");
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

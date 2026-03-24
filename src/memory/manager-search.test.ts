import { describe, expect, it, vi } from "vitest";
import { searchVector } from "./manager-search.js";

function createDb(rows: unknown[]) {
  return {
    prepare: () => ({
      all: () => rows,
    }),
  } as const;
}

describe("searchVector fallback", () => {
  it("returns top-k scores without sqlite-vec", async () => {
    const rows = [
      {
        id: "a",
        path: "p1",
        start_line: 1,
        end_line: 1,
        text: "a",
        embedding: "1,0",
        source: "memory",
      },
      {
        id: "b",
        path: "p2",
        start_line: 1,
        end_line: 1,
        text: "b",
        embedding: "0.8,0.2",
        source: "memory",
      },
      {
        id: "c",
        path: "p3",
        start_line: 1,
        end_line: 1,
        text: "c",
        embedding: "0,1",
        source: "memory",
      },
    ];
    const result = await searchVector({
      db: createDb(rows) as never,
      vectorTable: "vectors",
      providerModel: "test-model",
      queryVec: [1, 0],
      limit: 2,
      snippetMaxChars: 50,
      ensureVectorReady: vi.fn(async () => false),
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
    });
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
  });

  it("keeps only the best bounded top-k results in fallback mode", async () => {
    const rows = [
      {
        id: "low",
        path: "p0",
        start_line: 1,
        end_line: 1,
        text: "low",
        embedding: "[0,1]",
        source: "memory",
      },
      {
        id: "mid",
        path: "p1",
        start_line: 1,
        end_line: 1,
        text: "mid",
        embedding: "[0.7,0.3]",
        source: "memory",
      },
      {
        id: "high",
        path: "p2",
        start_line: 1,
        end_line: 1,
        text: "high",
        embedding: "[1,0]",
        source: "memory",
      },
      {
        id: "almost",
        path: "p3",
        start_line: 1,
        end_line: 1,
        text: "almost",
        embedding: "[0.95,0.05]",
        source: "memory",
      },
    ];
    const result = await searchVector({
      db: createDb(rows) as never,
      vectorTable: "vectors",
      providerModel: "test-model",
      queryVec: [1, 0],
      limit: 2,
      snippetMaxChars: 50,
      ensureVectorReady: vi.fn(async () => false),
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
    });
    expect(result.map((r) => r.id)).toEqual(["high", "almost"]);
  });
});

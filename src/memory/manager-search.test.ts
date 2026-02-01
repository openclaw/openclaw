import { describe, expect, it, vi } from "vitest";

import { searchVector } from "./manager-search.js";

describe("memory vector search SQL", () => {
  it("uses sqlite-vec knn query (MATCH + k) when available", async () => {
    const rows = [
      {
        id: "id-1",
        path: "MEMORY.md",
        start_line: 1,
        end_line: 1,
        text: "hello",
        source: "memory",
        dist: 0.1,
      },
    ];
    const all = vi.fn((..._args: unknown[]) => rows);
    const prepare = vi.fn((_sql: string) => ({ all }));
    const db = { prepare } as unknown as Parameters<typeof searchVector>[0]["db"];

    const result = await searchVector({
      db,
      vectorTable: "chunks_vec",
      providerModel: "mock-model",
      queryVec: [1, 2, 3],
      limit: 5,
      snippetMaxChars: 100,
      ensureVectorReady: async () => true,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
    });

    expect(result).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    const sql = String(prepare.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("embedding MATCH ? AND k = ?");
    expect(sql).toContain("WITH knn AS");
  });
});

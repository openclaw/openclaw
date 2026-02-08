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
    expect(sql).toContain("JOIN chunks c ON c.id = v.id");
  });

  it("pushes source filter into KNN selection and oversamples k", async () => {
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

    await searchVector({
      db,
      vectorTable: "chunks_vec",
      providerModel: "mock-model",
      queryVec: [1, 2, 3],
      limit: 5,
      snippetMaxChars: 100,
      ensureVectorReady: async () => true,
      sourceFilterVec: { sql: " AND c.source IN (?)", params: ["memory"] },
      sourceFilterChunks: { sql: " AND source IN (?)", params: ["memory"] },
    });

    const sql = String(prepare.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("WHERE c.model = ? AND c.source IN (?)");
    expect(sql).toContain("embedding MATCH ? AND k = ?");

    const args = all.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(args[0])).toBe(true);
    expect(args[1]).toBe("mock-model");
    expect(args[2]).toBe("memory");
    expect(Buffer.isBuffer(args[3])).toBe(true);
    expect(args[4]).toBe(50);
    expect(args[5]).toBe(5);
  });
});

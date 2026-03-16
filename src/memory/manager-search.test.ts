import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { searchKeyword } from "./manager-search.js";

describe("searchKeyword", () => {
  it("returns FTS matches regardless of indexed embedding model", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        id UNINDEXED,
        path UNINDEXED,
        source UNINDEXED,
        model UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );
    `);

    const insert = db.prepare(
      "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      "zebra keyword from old model",
      "1",
      "memory/2026-01-12.md",
      "memory",
      "mock-embed-v1",
      1,
      1,
    );
    insert.run(
      "zebra keyword from new model",
      "2",
      "memory/2026-01-13.md",
      "memory",
      "mock-embed-v2",
      1,
      1,
    );

    const results = await searchKeyword({
      db,
      ftsTable: "chunks_fts",
      query: "zebra",
      limit: 10,
      snippetMaxChars: 200,
      sourceFilter: { sql: "", params: [] },
      buildFtsQuery: (raw) => raw,
      bm25RankToScore: () => 1,
    });

    expect(results.map((r) => r.path)).toEqual(
      expect.arrayContaining(["memory/2026-01-12.md", "memory/2026-01-13.md"]),
    );
  });
});

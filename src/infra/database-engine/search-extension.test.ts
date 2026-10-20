import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildMemoryIndexStrictSchema } from "../../../packages/memory-host-sdk/src/host/memory-schema-base.js";
import {
  memoryTextSearchSchema,
  memoryVectorSearchSchema,
} from "../../../packages/memory-host-sdk/src/host/memory-search-schema.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitStoreSearch } from "./search-admission.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("binds a SQLite search extension without issuing any SQL", () => {
  using db = openNodeSqliteDatabase(":memory:");
  const prepare = vi.spyOn(db, "prepare");
  const exec = vi.spyOn(db, "exec");
  const search = admitStoreSearch(
    db,
    {
      text: { body: { table: "memory_fts", fields: ["text"] } },
      vector: { chunks: { table: "memory_vec", alias: "v", rowShape: { id: "string" } } },
    },
    { extension: "memory" },
  );
  expect(search.fullText).not.toBeNull();
  expect(search.vector).not.toBeNull();
  expect(search.text.body?.table).toBe("memory_fts");
  expect(search.vectors.chunks?.table).toBe("memory_vec");
  expect(prepare.mock.calls).toEqual([]);
  expect(exec.mock.calls).toEqual([]);
});

it.each([
  { tokenizer: "unicode61", original: "quartz", replacement: "saffron" },
  { tokenizer: "trigram", original: "uart", replacement: "affr" },
] as const)(
  "keeps canonical $tokenizer search fresh after re-admission without DDL",
  ({ tokenizer, original, replacement }) => {
    using db = openNodeSqliteDatabase(":memory:");
    db.exec(
      buildMemoryIndexStrictSchema({
        embeddingCacheTable: "memory_embedding_cache",
        includeEmbeddingCache: false,
      }),
    );
    db.exec(`
      INSERT INTO memory_index_sources (id, path, source, hash, mtime, size)
        VALUES (17, 'quartz.md', 'memory', 'hash', 1, 1);
      INSERT INTO memory_index_chunks
        (chunk_rowid, id, path, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES (41, 'chunk', 'quartz.md', 1, 1, 'hash', 'model', 'quartz compass', X'', 1);
    `);
    const definition = memoryTextSearchSchema(tokenizer);
    const first = admitStoreSearch(db, definition, { extension: "memory.text" });
    expect(first.text.body?.table).toBe("memory_index_chunks_fts");
    expect(first.text.paths?.table).toBe("memory_index_paths_fts");
    const body = db.prepare(
      "SELECT rowid, id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
    );
    const paths = db.prepare(
      "SELECT rowid, path FROM memory_index_paths_fts WHERE memory_index_paths_fts MATCH ?",
    );
    expect(body.all(original)).toEqual([{ rowid: 41, id: "chunk" }]);
    expect(paths.all(original)).toEqual([{ rowid: 17, path: "quartz.md" }]);

    const exec = vi.spyOn(db, "exec");
    admitStoreSearch(db, definition, { extension: "memory.text" });
    // Re-admission must preserve the maintenance triggers without replaying their DDL.
    expect(exec.mock.calls.filter(([sql]) => /\b(?:CREATE|DROP|ALTER)\b/iu.test(sql))).toEqual([]);
    exec.mockRestore();

    db.exec(`
      UPDATE memory_index_sources SET path = 'saffron.md' WHERE id = 17;
      UPDATE memory_index_chunks SET text = 'saffron compass', path = 'saffron.md' WHERE id = 'chunk';
    `);
    expect(body.all(original)).toEqual([]);
    expect(paths.all(original)).toEqual([]);
    expect(body.all(replacement)).toEqual([{ rowid: 41, id: "chunk" }]);
    expect(paths.all(replacement)).toEqual([{ rowid: 17, path: "saffron.md" }]);

    db.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources");
    expect(body.all(replacement)).toEqual([]);
    expect(paths.all(replacement)).toEqual([]);
  },
);

it.each(["admission", "writer", "existing table admission"] as const)(
  "reuses the vector schema published by %s and invalidates it after a dimension rebuild",
  async (creator) => {
    const databasePath = path.join(tempDirs.make("memory-search-admission-"), "memory.sqlite");
    using db = openNodeSqliteDatabase(databasePath, { allowExtension: true });
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    const definition = memoryVectorSearchSchema(3);
    const first = admitStoreSearch(
      db,
      definition,
      creator === "admission" ? { extension: "memory.vector" } : undefined,
    );
    if (creator !== "admission") {
      // IF NOT EXISTS cannot certify which schema was present; admission must inspect it once.
      first.vector!.create(first.vectors.chunks!, 3, creator === "existing table admission");
      if (creator === "existing table admission") {
        admitStoreSearch(db, definition, { extension: "memory.vector" });
      }
    }
    first.vector!.write(first.vectors.chunks!, [{ id: "before", embedding: [1, 0, 0] }]);

    const prepare = vi.spyOn(db, "prepare");
    const exec = vi.spyOn(db, "exec");
    const readmitted = admitStoreSearch(db, definition, { extension: "memory.vector" });
    expect(prepare.mock.calls).toEqual([]);
    expect(exec.mock.calls).toEqual([]);
    prepare.mockRestore();
    exec.mockRestore();
    expect(readmitted.vector!.prepareExists(readmitted.vectors.chunks!)("before")).toBe(true);

    readmitted.vector!.drop(readmitted.vectors.chunks!);
    readmitted.vector!.create(readmitted.vectors.chunks!, 4);
    readmitted.vector!.write(readmitted.vectors.chunks!, [
      { id: "after", embedding: [0, 1, 0, 0] },
    ]);
    // Admission reports incompatible dimensions; only the memory owner may rebuild derived data.
    expect(() => admitStoreSearch(db, definition, { extension: "memory.vector" })).toThrow(
      "rebuild the derived memory index",
    );
    const rebuilt = admitStoreSearch(db, memoryVectorSearchSchema(4), {
      extension: "memory.vector",
    });
    const exists = rebuilt.vector!.prepareExists(rebuilt.vectors.chunks!);
    expect(exists("before")).toBe(false);
    expect(exists("after")).toBe(true);
    expect(
      db.prepare("SELECT vec_length(embedding) AS dimensions FROM memory_index_chunks_vec").all(),
    ).toEqual([{ dimensions: 4 }]);
  },
);

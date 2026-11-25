import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readGeneratedSqliteCatalog } from "../../state/postgres-schema.generated/sqlite-catalogs.js";
import { createSqliteTableContractReader } from "../sqlite-schema-catalog.js";
import {
  buildSqliteMemoryBodyFtsSchema,
  buildSqliteMemoryPathFtsSchema,
  buildSqliteMemoryVectorSchema,
  getSqliteMemorySearchFragmentFingerprint,
  matchesSqliteMemorySearchFragment,
} from "./sqlite-memory-search-fragments.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

function readCatalog(db: DatabaseSync, tableName: string) {
  return createSqliteTableContractReader(db, [], [tableName]).readCatalog([], [tableName]);
}
type Fragment = Parameters<typeof matchesSqliteMemorySearchFragment>[1];
const matches = (db: DatabaseSync, fragment: Fragment) =>
  matchesSqliteMemorySearchFragment(readCatalog(db, fragment.tableName), fragment);

function expectShadowDrift(db: DatabaseSync, fragment: Fragment, shadow: string) {
  expect(matches(db, fragment)).toBe(true);
  db.enableDefensive?.(false);
  db.exec(`ALTER TABLE ${fragment.tableName}_${shadow} ADD COLUMN unexpected TEXT`);
  expect(matches(db, fragment)).toBe(false);
}

async function loadVectorDb(db: DatabaseSync) {
  const loaded = await loadSqliteVecExtension({ db });
  expect(loaded.ok, loaded.error).toBe(true);
}

describe("generated memory search fragments", () => {
  it.each([1, 3, 1536])(
    "computes vec0 facts for %i dimensions from one native template",
    async (dimensions) => {
      using db = new DatabaseSync(":memory:", { allowExtension: true });
      await loadVectorDb(db);
      const fragment: Fragment = {
        kind: "vector",
        tableName: "memory_index_chunks_vec",
        dimensions,
      };
      // This is the persisted native declaration; the generator uses the engine's builder.
      db.exec(
        `CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(\n  id TEXT PRIMARY KEY,\n  embedding FLOAT[${dimensions}]\n)`,
      );
      const actual = readCatalog(db, fragment.tableName);
      const template = readGeneratedSqliteCatalog(
        buildSqliteMemoryVectorSchema({ ...fragment, dimensions: 1 }),
      );
      expect({
        ...actual,
        tables: actual.tables.map((table) =>
          table.name === fragment.tableName
            ? { ...table, sql: table.sql?.replace(`FLOAT[${dimensions}]`, "FLOAT[1]") }
            : table,
        ),
      }).toEqual(template);
      expect(
        matchesSqliteMemorySearchFragment(actual, { ...fragment, dimensions: dimensions + 1 }),
      ).toBe(false);
      expect(getSqliteMemorySearchFragmentFingerprint(fragment)).toEqual(
        getSqliteMemorySearchFragmentFingerprint({ ...fragment, dimensions: 1 }),
      );

      expectShadowDrift(db, fragment, "info");
    },
  );

  it("matches a custom vec0 table name without materializing expected facts", async () => {
    using db = new DatabaseSync(":memory:", { allowExtension: true });
    await loadVectorDb(db);
    db.exec(
      "CREATE VIRTUAL TABLE custom_memory_vec USING vec0(\n  id TEXT PRIMARY KEY,\n  embedding FLOAT[3]\n)",
    );
    const fragment = { kind: "vector", tableName: "custom_memory_vec", dimensions: 3 } as const;
    expectShadowDrift(db, fragment, "info");
  });

  const textFragments = [
    { kind: "body-fts", tableName: "memory_index_chunks_fts", tokenizer: "unicode61" },
    { kind: "body-fts", tableName: "memory_index_chunks_fts", tokenizer: "trigram" },
    { kind: "path-fts", tableName: "memory_index_paths_fts", tokenizer: "unicode61" },
    { kind: "path-fts", tableName: "memory_index_paths_fts", tokenizer: "trigram" },
    { kind: "body-fts", tableName: "custom_memory_fts", tokenizer: "unicode61" },
    { kind: "path-fts", tableName: "custom_memory_paths_fts", tokenizer: "trigram" },
  ] as const;
  it.each(textFragments)(
    "matches $kind $tokenizer facts for $tableName and rejects shadow drift",
    (fragment) => {
      using db = new DatabaseSync(":memory:");
      db.exec(
        fragment.kind === "body-fts"
          ? buildSqliteMemoryBodyFtsSchema(fragment)
          : buildSqliteMemoryPathFtsSchema(fragment),
      );
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
      const catalog = readCatalog(db, fragment.tableName);
      expect(
        matchesSqliteMemorySearchFragment(catalog, {
          ...fragment,
          tokenizer: fragment.tokenizer === "unicode61" ? "trigram" : "unicode61",
        }),
      ).toBe(false);
      expectShadowDrift(db, fragment, "config");
    },
  );

  it.each(["'", '"'])(
    "retains the shipped explicit unicode61 tokenizer with %s quoting",
    (quote) => {
      using db = new DatabaseSync(":memory:");
      db.exec(
        `CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(\n  text,\n  id UNINDEXED,\n  path UNINDEXED,\n  source UNINDEXED,\n  model UNINDEXED,\n  start_line UNINDEXED,\n  end_line UNINDEXED\n, tokenize=${quote}unicode61${quote});`,
      );
      expect(
        matches(db, {
          kind: "body-fts",
          tableName: "memory_index_chunks_fts",
          tokenizer: "unicode61",
        }),
      ).toBe(true);
    },
  );
});

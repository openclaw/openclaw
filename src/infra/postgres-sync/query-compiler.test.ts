import { DatabaseSync } from "node:sqlite";
import { Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  encodeSqliteStringSet,
  getNodeSqliteKysely,
  sqliteStringSet,
  sqliteStringSetEntries,
} from "../kysely-sync.js";
import { OpenClawPostgresDialect } from "./query-compiler.js";

type Tables = { items: { id: string; name: string } };
const postgres = new Kysely<Tables>({
  dialect: new OpenClawPostgresDialect({
    pool: async () => {
      throw new Error("Compile-only test must not connect");
    },
  }),
});

// These cases protect the dialect boundary and parameter order; existing sync-helper
// tests own SQLite execution, while the workboard PostgreSQL lane owns live execution.
describe("PostgreSQL string-set compilation", () => {
  it("lowers a set without changing values or parameter order", () => {
    const values = ["a", "λ🦞", "'); drop table items; --"];
    const compiled = postgres
      .selectFrom("items")
      .selectAll()
      .where("name", "=", "first")
      .where("id", "in", sqliteStringSet(values))
      .compile();
    expect(compiled.sql).toBe(
      'select * from "items" where "name" = $1 and "id" in (SELECT value FROM json_array_elements_text($2::json) AS value)',
    );
    expect(compiled.parameters).toEqual(["first", encodeSqliteStringSet(values)]);
  });

  it("lowers entries with zero-based keys and a bound or expression input", () => {
    for (const input of [
      '["a",null]',
      // kysely-allow-raw: Exercise a caller-supplied bound expression.
      sql<string>`${'["a",null]'}`,
    ]) {
      const compiled = postgres
        .selectFrom(sqliteStringSetEntries(input).as("entry"))
        .select(["entry.key", "entry.value"])
        .compile();
      expect(compiled.sql).toBe(
        'select "entry"."key", "entry"."value" from (SELECT ordinality - 1 AS key, value FROM json_array_elements_text($1::json) WITH ORDINALITY AS entries(value, ordinality)) as "entry"',
      );
      expect(compiled.parameters).toEqual(['["a",null]']);
    }
  });

  it("leaves unrelated raw SQL with identical text untouched", () => {
    const compiled = sql`(SELECT value FROM json_each(${"[]"}))`.compile(postgres);
    expect(compiled.sql).toBe("(SELECT value FROM json_each($1))");
    expect(compiled.parameters).toEqual(["[]"]);
  });

  it("preserves the SQLite helper SQL byte-for-byte", () => {
    const connection = new DatabaseSync(":memory:");
    try {
      const sqlite = getNodeSqliteKysely<Tables>(connection);
      const set = sqlite
        .selectFrom("items")
        .selectAll()
        .where("name", "=", "first")
        .where("id", "in", sqliteStringSet(["a", "b"]))
        .compile();
      expect(set.sql).toBe(
        'select * from "items" where "name" = ? and "id" in (SELECT value FROM json_each(?))',
      );
      expect(set.parameters).toEqual(["first", '["a","b"]']);
      const entries = sqlite
        .selectFrom(sqliteStringSetEntries('["a",null]').as("entry"))
        .selectAll()
        .compile();
      expect(entries.sql).toBe('select * from json_each(?) as "entry"');
      expect(entries.parameters).toEqual(['["a",null]']);
    } finally {
      connection.close();
    }
  });
});

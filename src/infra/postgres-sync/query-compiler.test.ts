import { DatabaseSync } from "node:sqlite";
import { Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  compileSqliteQueryBindings,
  encodeSqliteStringSet,
  getNodeSqliteKysely,
  sqliteStringSet,
  sqliteStringSetEntries,
} from "../kysely-sync.js";
import { OpenClawPostgresDialect, sqliteStringSetFragments } from "../sql-query-compiler.js";

type Tables = { items: { id: string; name: string } };
const postgres = new Kysely<Tables>({
  dialect: new OpenClawPostgresDialect({
    pool: async () => {
      throw new Error("Compile-only test must not connect");
    },
  }),
});

// Live two-engine semantics and the selective index plan are covered by string-set.conformance.
describe("PostgreSQL string-set compilation", () => {
  it("lowers positive membership without changing parameter positions or count", () => {
    const values = ["a", "λ🦞", "'); drop table items; --"];
    const compiled = postgres
      .selectFrom("items")
      .selectAll()
      .where("name", "=", "first")
      .where("id", "in", sqliteStringSet(values))
      .where("name", "!=", "last")
      .compile();
    expect(compiled.sql).toBe(
      'select * from "items" where "name" = $1 and "id" = ANY($2::text[]) and "name" != $3',
    );
    expect(compiled.parameters).toEqual([
      "first",
      '{"a","λ🦞","\'); drop table items; --"}',
      "last",
    ]);
  });

  it.each([
    [[], "{}"],
    [['"', "\\", ",", "{", "}"], '{"\\\"","\\\\",",","{","}"}'],
    [[" leading", "trailing ", "", "NULL"], '{" leading","trailing ","","NULL"}'],
    [["λ🦞", "\ud800", "\udfff"], '{"λ🦞","�","�"}'],
    [["a", "a", "line\nnext"], '{"a","a","line\nnext"}'],
  ])("encodes PostgreSQL array elements exactly: %j", (values, encoded) => {
    const compiled = postgres
      .selectFrom("items")
      .selectAll()
      .where("id", "in", sqliteStringSet(values))
      .compile();
    expect(compiled.sql).toBe('select * from "items" where "id" = ANY($1::text[])');
    expect(compiled.parameters).toEqual([encoded]);
  });

  it.each(["null", '["a",null]', "[1]", "{}", "[invalid", '["a\\x00b"]'])(
    "keeps the existing lowering for unsupported input %s",
    (encoded) => {
      // kysely-allow-raw: Exercise the shared primitive's identity with unsupported bindings.
      const set = sql<string>(sqliteStringSetFragments, encoded);
      const compiled = postgres.selectFrom("items").selectAll().where("id", "in", set).compile();
      expect(compiled.sql).toBe(
        'select * from "items" where "id" in (SELECT value FROM json_array_elements_text($1::json) AS value)',
      );
      expect(compiled.parameters).toEqual([encoded]);
    },
  );

  it("keeps NOT IN, relation-valued sets and opaque predicates unchanged", () => {
    const values = ["a", "b"];
    const excluded = postgres
      .selectFrom("items")
      .selectAll()
      .where("id", "not in", sqliteStringSet(values))
      .compile();
    expect(excluded.sql).toBe(
      'select * from "items" where "id" not in (SELECT value FROM json_array_elements_text($1::json) AS value)',
    );
    const relation = postgres
      .selectFrom(sqliteStringSet(values).as("requested"))
      .selectAll()
      .compile();
    expect(relation.sql).toBe(
      'select * from (SELECT value FROM json_array_elements_text($1::json) AS value) as "requested"',
    );
    // kysely-allow-raw: Opaque caller-owned SQL must not be parsed or rewritten.
    const opaque = sql`id IN ${sqliteStringSet(values)}`.compile(postgres);
    expect(opaque.sql).toBe(
      "id IN (SELECT value FROM json_array_elements_text($1::json) AS value)",
    );
    for (const compiled of [excluded, relation, opaque]) {
      expect(compiled.parameters).toEqual([encodeSqliteStringSet(values)]);
    }
  });

  it("preserves deferred positive membership and entries bindings on repeated calls", () => {
    const deferred = compileSqliteQueryBindings<{ encoded: string; name: string }>((parameter) => {
      // kysely-allow-raw: The deferred marker is an opaque bound expression, not a concrete set.
      const set = sql<string>(
        sqliteStringSetFragments,
        parameter((params) => params.encoded),
      );
      return postgres
        .selectFrom("items")
        .selectAll()
        .where(
          "name",
          "=",
          parameter((params) => params.name),
        )
        .where("id", "in", set);
    });
    expect(deferred.compiled.sql).toBe(
      'select * from "items" where "name" = $1 and "id" in (SELECT value FROM json_array_elements_text($2::json) AS value)',
    );
    const entries = compileSqliteQueryBindings<{ encoded: string }>((parameter) =>
      postgres
        .selectFrom(sqliteStringSetEntries(parameter((params) => params.encoded)).as("entry"))
        .selectAll(),
    );
    expect(entries.compiled.sql).toBe(
      'select * from (SELECT ordinality - 1 AS key, value FROM json_array_elements_text($1::json) WITH ORDINALITY AS entries(value, ordinality)) as "entry"',
    );
    for (const encoded of ['["a","b"]', "[]", '["new"]']) {
      expect(deferred.bind({ encoded, name: "first" })).toEqual(["first", encoded]);
      expect(entries.bind({ encoded })).toEqual([encoded]);
    }
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
    const entries = sql`json_each(${"[]"})`.compile(postgres);
    expect(entries.sql).toBe("json_each($1)");
    expect(entries.parameters).toEqual(["[]"]);
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

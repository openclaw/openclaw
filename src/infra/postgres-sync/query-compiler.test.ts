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
const items = () => postgres.selectFrom("items").selectAll();
const jsonSet = (position = 1) =>
  `(SELECT value FROM json_array_elements_text($${position}::json) AS value)`;
const jsonEntries =
  "(SELECT ordinality - 1 AS key, value FROM json_array_elements_text($1::json) WITH ORDINALITY AS entries(value, ordinality))";
function expectQuery(
  query: { compile(): { sql: string; parameters: readonly unknown[] } },
  expectedSql: string,
  parameters: unknown[],
) {
  const compiled = query.compile();
  expect([compiled.sql, compiled.parameters]).toEqual([expectedSql, parameters]);
}

// Live two-engine semantics and the selective index plan are covered by string-set.conformance.
describe("PostgreSQL string-set compilation", () => {
  it("lowers positive membership without changing parameter positions or count", () => {
    const values = ["a\n", "λ🦞", "'); drop table items; --"];
    expectQuery(
      items()
        .where("name", "=", "first")
        .where("id", "in", sqliteStringSet(values))
        .where("name", "!=", "last"),
      'select * from "items" where "name" = $1 and "id" = ANY($2::text[]) and "name" != $3',
      ["first", '{"a\n","λ🦞","\'); drop table items; --"}', "last"],
    );
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
      expectQuery(
        items().where("id", "in", set),
        `select * from "items" where "id" in ${jsonSet()}`,
        [encoded],
      );
    },
  );

  it("keeps NOT IN, relation-valued sets and opaque predicates unchanged", () => {
    const values = ["a", "b"];
    const parameters = [encodeSqliteStringSet(values)];
    expectQuery(
      items().where("id", "not in", sqliteStringSet(values)),
      `select * from "items" where "id" not in ${jsonSet()}`,
      parameters,
    );
    expectQuery(
      postgres.selectFrom(sqliteStringSet(values).as("requested")).selectAll(),
      `select * from ${jsonSet()} as "requested"`,
      parameters,
    );
    // kysely-allow-raw: Opaque caller-owned SQL must not be parsed or rewritten.
    const opaque = sql`id IN ${sqliteStringSet(values)}`.compile(postgres);
    expect([opaque.sql, opaque.parameters]).toEqual([`id IN ${jsonSet()}`, parameters]);
  });

  it("preserves deferred membership on repeated bindings", () => {
    const deferred = compileSqliteQueryBindings<string>((parameter) => {
      // kysely-allow-raw: The deferred marker is an opaque bound expression, not a concrete set.
      const set = sql<string>(
        sqliteStringSetFragments,
        parameter((encoded) => encoded),
      );
      return items().where("id", "in", set);
    });
    expect(deferred.compiled.sql).toBe(`select * from "items" where "id" in ${jsonSet()}`);
    for (const encoded of ['["a","b"]', "[]", '["new"]']) {
      expect(deferred.bind(encoded)).toEqual([encoded]);
    }
  });

  it("lowers entries with zero-based keys and a bound or expression input", () => {
    for (const input of [
      '["a",null]',
      // kysely-allow-raw: Exercise a caller-supplied bound expression.
      sql<string>`${'["a",null]'}`,
    ]) {
      expectQuery(
        postgres
          .selectFrom(sqliteStringSetEntries(input).as("entry"))
          .select(["entry.key", "entry.value"]),
        `select "entry"."key", "entry"."value" from ${jsonEntries} as "entry"`,
        ['["a",null]'],
      );
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

  it("preserves native SQLite entries compilation", () => {
    const connection = new DatabaseSync(":memory:");
    try {
      const sqlite = getNodeSqliteKysely<Tables>(connection);
      expectQuery(
        sqlite.selectFrom(sqliteStringSetEntries('["a",null]').as("entry")).selectAll(),
        'select * from json_each(?) as "entry"',
        ['["a",null]'],
      );
    } finally {
      connection.close();
    }
  });
});

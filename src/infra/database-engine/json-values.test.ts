import { sql } from "kysely";
import { expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import {
  jsonArrayFrom,
  jsonArrayValue,
  jsonObjectFrom,
  jsonOrderedArray,
  jsonPathValue,
  jsonPickObject,
  jsonRemovePaths,
  jsonSetPath,
  jsonValid,
} from "./json-values.js";

it("preserves ordered row objects, JSON text fields, and empty projection results", () => {
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, rank INTEGER, payload TEXT)");
  const insert = db.prepare("INSERT INTO items VALUES (?, ?, ?)");
  insert.run("b", 2, '{"nested":true}');
  insert.run("a", null, "λ🦞");
  const query = getNodeSqliteKysely<{
    items: { id: string; rank: number | null; payload: string };
  }>(db);
  const selected = query
    .selectFrom("items")
    .select(["id", "rank", "payload"])
    .orderBy("rank")
    .orderBy("id");
  const result = executeSqliteQuerySync(
    db,
    query.selectNoFrom([
      jsonArrayFrom(db, selected, ["rank", "id"]).as("rows"),
      jsonObjectFrom(db, selected.where("id", "=", "b")).as("row"),
      jsonArrayFrom(db, selected.where("id", "=", "missing"), ["id"]).as("empty"),
      jsonObjectFrom(db, selected.where("id", "=", "missing")).as("absent"),
    ]),
  ).rows[0]!;
  expect(result).toEqual({
    rows: '[{"id":"a","rank":null,"payload":"λ🦞"},{"id":"b","rank":2,"payload":"{\\"nested\\":true}"}]',
    row: '{"id":"b","rank":2,"payload":"{\\"nested\\":true}"}',
    empty: "[]",
    absent: null,
  });
});

it("projects nested JSON and reparents without changing opaque data or scalar types", () => {
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(":memory:");
  const query = getNodeSqliteKysely<Record<string, never>>(db);
  const event = sql.val(
    '{"parentId":"old","data":{"text":"λ🦞","flag":true},"message":{"role":"assistant","tokens":3,"private":null}}',
  );
  const projected = jsonRemovePaths(db, event, [sql.lit("$.message.private")]);
  const result = executeSqliteQuerySync(
    db,
    query.selectNoFrom([
      jsonSetPath(db, projected, sql.lit("$.parentId"), sql.val(null)).as("event"),
      jsonPathValue(db, event, sql.lit("$.message.tokens"), "number").as("tokens"),
      jsonPathValue(db, event, sql.lit("$.message.role")).as("role"),
      jsonPickObject(db, event, ["data", "absent"]).as("picked"),
      jsonValid(db, sql.val("malformed")).as("valid"),
    ]),
  ).rows[0]!;
  expect(JSON.parse(result.event)).toEqual({
    parentId: null,
    data: { text: "λ🦞", flag: true },
    message: { role: "assistant", tokens: 3 },
  });
  expect(result.tokens).toBe(3);
  expect(result.role).toBe("assistant");
  expect(JSON.parse(result.picked)).toEqual({ data: { text: "λ🦞", flag: true } });
  expect(result.valid).toBe(0);
});

it("aggregates typed tuples in key order without quoting nested arrays", () => {
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, rank INTEGER)");
  db.exec("INSERT INTO items VALUES ('b', 2), ('a', NULL)");
  const query = getNodeSqliteKysely<{ items: { id: string; rank: number | null } }>(db);
  const aggregate = query
    .selectFrom("items")
    .select((eb) =>
      jsonOrderedArray(db, jsonArrayValue(db, [eb.ref("id"), eb.ref("rank")]), [
        eb.ref("rank"),
        eb.ref("id"),
      ]).as("value"),
    );
  expect(executeSqliteQuerySync(db, aggregate).rows).toEqual([{ value: '[["a",null],["b",2]]' }]);
  expect(executeSqliteQuerySync(db, aggregate.where("id", "=", "missing")).rows).toEqual([
    { value: "[]" },
  ]);
});

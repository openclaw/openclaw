import { expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import { jsonArrayFrom, jsonArrayValue, jsonObjectFrom, jsonOrderedArray } from "./json-values.js";

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

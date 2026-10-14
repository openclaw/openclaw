import type { DatabaseSync } from "node:sqlite";
import {
  expressionBuilder,
  sql,
  type AliasableExpression,
  type Expression,
  type RawBuilder,
  type ShallowDehydrateObject,
  type Simplify,
} from "kysely";
import {
  jsonArrayFrom as sqliteJsonArrayFrom,
  jsonObjectFrom as sqliteJsonObjectFrom,
} from "kysely/helpers/sqlite";
import { getNodeSqliteKysely } from "../kysely-sync.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";

/** Project caller-selected rows as JSON text, retaining their explicit order. */
export function jsonArrayFrom<O>(
  db: DatabaseSync | PostgresSqlConnection,
  rows: Parameters<typeof sqliteJsonArrayFrom<O>>[0],
  orderBy: readonly (keyof O & string)[],
): RawBuilder<Simplify<ShallowDehydrateObject<O>>[]> {
  if (!isPostgresSqlConnection(db)) {
    return sqliteJsonArrayFrom(rows);
  }
  const eb = expressionBuilder<{ agg: O }, "agg">();
  const order = orderBy.length
    ? sql`order by ${sql.join(orderBy.map((key) => sql`${eb.ref(`agg.${key}`)} asc nulls first`))}`
    : sql``;
  // Keep text at the driver boundary; callers perform their existing JSON validation.
  return /* kysely-allow-raw: Engine-owned ordered row aggregation. */ sql<
    Simplify<ShallowDehydrateObject<O>>[]
  >`(select coalesce(json_agg(agg ${order}), '[]')::text from ${rows} as agg)`;
}

/** Project at most one caller-selected row, preserving SQL NULL when absent. */
export function jsonObjectFrom<O>(
  db: DatabaseSync | PostgresSqlConnection,
  row: Parameters<typeof sqliteJsonObjectFrom<O>>[0],
): RawBuilder<Simplify<ShallowDehydrateObject<O>> | null> {
  return isPostgresSqlConnection(db)
    ? /* kysely-allow-raw: Engine-owned row-to-JSON projection. */ sql<Simplify<
        ShallowDehydrateObject<O>
      > | null>`(select row_to_json(obj)::text from ${row} as obj)`
    : sqliteJsonObjectFrom(row);
}

export function jsonArrayValue(
  db: DatabaseSync | PostgresSqlConnection,
  values: readonly Expression<unknown>[],
): RawBuilder<string> {
  return /* kysely-allow-raw: Engine-owned JSON tuple construction. */ sql<string>`${sql.raw(isPostgresSqlConnection(db) ? "json_build_array" : "json_array")}(${sql.join(values)})`;
}

/** JSON-valued inputs remain JSON instead of becoming quoted strings. */
export function jsonOrderedArray(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string>,
  orderBy: readonly Expression<unknown>[],
): AliasableExpression<string> {
  const postgres = isPostgresSqlConnection(db);
  let aggregate = expressionBuilder().fn.agg<string>(postgres ? "json_agg" : "json_group_array", [
    value,
  ]);
  for (const key of orderBy) {
    aggregate = aggregate.orderBy(key, (order) => order.asc().nullsFirst());
  }
  return postgres
    ? /* kysely-allow-raw: JSON aggregates cross the driver as text, including empty arrays. */ sql<string>`coalesce(${aggregate}::text, '[]')`
    : aggregate;
}

/** Expand a caller-owned string map without changing JSON values into quoted text. */
export function jsonObjectTextEntries(db: DatabaseSync | PostgresSqlConnection, value: string) {
  /* kysely-allow-raw: PostgreSQL requires a typed JSON input. */
  const postgres = isPostgresSqlConnection(db);
  return getNodeSqliteKysely(db).fn<{ key: string; value: string }>(
    postgres ? "json_each_text" : "json_each",
    [postgres ? sql`${value}::json` : sql.val(value)],
  );
}

/** Read a string from a caller-owned JSON tuple. */
export function jsonArrayTextElement(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string | null>,
  index: number,
) {
  /* kysely-allow-raw: PostgreSQL requires a typed JSON input. */
  return isPostgresSqlConnection(db)
    ? getNodeSqliteKysely(db).fn<string>("json_extract_path_text", [
        sql`${value}::json`,
        sql.val(String(index)),
      ])
    : getNodeSqliteKysely(db).fn<string>("json_extract", [value, sql.val(`$[${index}]`)]);
}

function jsonKeyPath(key: string): string {
  return `$.${/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ? key : JSON.stringify(key)}`;
}

export function jsonExtractText(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string | null>,
  key: string,
): AliasableExpression<string | null> {
  const eb = expressionBuilder();
  /* kysely-allow-raw: Engine-owned JSON scalar projection. */
  return isPostgresSqlConnection(db)
    ? eb.fn<string | null>("json_extract_path_text", [sql`${value}::json`, eb.val(key)])
    : eb.fn<string | null>("json_extract", [value, eb.val(jsonKeyPath(key))]);
}

export function jsonOrderedTextArray(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string | null>,
  orderBy: Expression<unknown>,
): AliasableExpression<string> {
  // SQLite consumes caller-ordered rows; PostgreSQL requires ordering within the aggregate.
  return isPostgresSqlConnection(db)
    ? /* kysely-allow-raw: Engine-owned ordered JSON aggregation. */ sql<string>`coalesce(array_to_json(array_agg(${value} order by ${orderBy}))::text, '[]')`
    : expressionBuilder().fn<string>("json_group_array", [value]);
}

export function jsonRemoveKey(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string | null>,
  key: string,
): AliasableExpression<string | null> {
  if (isPostgresSqlConnection(db)) {
    // jsonb normalizes key order/whitespace and keeps the last duplicate; parsed values agree, bytes may differ.
    return /* kysely-allow-raw: Engine-owned JSON key removal. */ sql<
      string | null
    >`(${value}::jsonb - ${key}::text)::text`;
  }
  return expressionBuilder().fn<string | null>("json_remove", [
    value,
    expressionBuilder().val(jsonKeyPath(key)),
  ]);
}

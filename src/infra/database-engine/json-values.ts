import type { DatabaseSync } from "node:sqlite";
import { expressionBuilder, sql, type AliasableExpression, type Expression } from "kysely";
import { getNodeSqliteKysely } from "../kysely-sync.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";

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

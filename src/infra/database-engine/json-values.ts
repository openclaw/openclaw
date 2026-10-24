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

export function jsonObjectValue(
  db: DatabaseSync | PostgresSqlConnection,
  fields: Readonly<Record<string, Expression<unknown>>>,
) {
  return /* kysely-allow-raw: Engine-owned typed JSON object construction. */ sql<string>`${sql.raw(isPostgresSqlConnection(db) ? "json_build_object" : "json_object")}(${sql.join(Object.entries(fields).flatMap(([key, value]) => [sql.lit(key), value]))})`;
}

/** JSON-valued inputs remain JSON instead of becoming quoted strings. */
export function jsonOrderedArray(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string>,
  orderBy: readonly Expression<unknown>[],
  nullOrder: "first" | "native" = "first",
): AliasableExpression<string> {
  const postgres = isPostgresSqlConnection(db);
  let aggregate = expressionBuilder().fn.agg<string>(postgres ? "json_agg" : "json_group_array", [
    value,
  ]);
  for (const key of orderBy) {
    aggregate = aggregate.orderBy(key, (order) =>
      nullOrder === "first" ? order.asc().nullsFirst() : order.asc(),
    );
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

/** SQLite JSON paths at these boundaries name object keys, including nested keys. */
function objectPath(path: Expression<string>) {
  /* kysely-allow-raw: Translate a bound object-member path, never SQL source. */
  return sql`string_to_array(substr(${path}, 3), '.')`;
}

export function jsonPathValue<T = string | null>(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<unknown>,
  path: Expression<string>,
  kind: "text" | "number" | "json" = "text",
): RawBuilder<T> {
  if (!isPostgresSqlConnection(db)) {
    return /* kysely-allow-raw: Preserve the caller's SQLite path binding and SQL text. */ sql<T>`json_extract(${value}, ${path})`;
  }
  const extracted = /* kysely-allow-raw: Engine-owned JSON path projection. */ sql`(${value}::jsonb ${sql.raw(kind === "json" ? "#>" : "#>>")} ${objectPath(path)})`;
  return /* kysely-allow-raw: JSON crosses the driver as text; numbers retain numeric driver values. */ sql<T>`${extracted}${sql.raw(kind === "number" ? "::double precision" : kind === "json" ? "::text" : "")}`;
}

export function jsonValid(db: DatabaseSync | PostgresSqlConnection, value: Expression<unknown>) {
  return isPostgresSqlConnection(db)
    ? /* kysely-allow-raw: PostgreSQL 16+ validates JSON without raising a parse error. */ sql`pg_input_is_valid(${value}, 'json')`
    : /* kysely-allow-raw: Keep SQLite validation unchanged. */ sql`json_valid(${value})`;
}

export function jsonType(db: DatabaseSync | PostgresSqlConnection, value: Expression<unknown>) {
  return isPostgresSqlConnection(db)
    ? /* kysely-allow-raw: Engine-owned JSON value classification. */ sql<string>`jsonb_typeof(${value}::jsonb)`
    : /* kysely-allow-raw: Engine-owned JSON value classification. */ sql<string>`json_type(${value})`;
}

export function jsonRemovePaths(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<unknown>,
  paths: readonly Expression<string>[],
): RawBuilder<string> {
  if (!isPostgresSqlConnection(db)) {
    return /* kysely-allow-raw: Keep SQLite's multi-path removal and bindings unchanged. */ sql<string>`json_remove(${value}, ${sql.join(paths)})`;
  }
  let result = /* kysely-allow-raw: Engine-owned JSON mutation. */ sql`${value}::jsonb`;
  for (const path of paths) {
    result = sql`(${result} #- ${objectPath(path)})`;
  }
  return /* kysely-allow-raw: Return the JSON mutation as driver text. */ sql<string>`${result}::text`;
}

/** Set text/null, or a JSON-producing expression when json is true. */
export function jsonSetPath(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<unknown>,
  path: Expression<string>,
  replacement: Expression<string | null>,
  json = false,
): RawBuilder<string> {
  if (!isPostgresSqlConnection(db)) {
    return /* kysely-allow-raw: Preserve SQLite's JSON subtype at the call site. */ sql<string>`json_set(${value}, ${path}, ${replacement})`;
  }
  const next = json ? sql`${replacement}::jsonb` : sql`to_jsonb(${replacement}::text)`;
  return /* kysely-allow-raw: SQL NULL replacements represent explicit JSON null. */ sql<string>`jsonb_set(${value}::jsonb, ${objectPath(path)}, coalesce(${next}, 'null'::jsonb))::text`;
}

export function jsonArrayElements(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<unknown>,
) {
  return /* kysely-allow-raw: Both table functions expose a value column. */ sql`${sql.raw(isPostgresSqlConnection(db) ? "jsonb_array_elements" : "json_each")}(${value}${sql.raw(isPostgresSqlConnection(db) ? "::jsonb" : "")})`;
}

export function jsonPickObject(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<unknown>,
  keys: readonly string[],
): RawBuilder<string> {
  return isPostgresSqlConnection(db)
    ? /* kysely-allow-raw: Keep only selected object members, preserving missing versus null. */ sql<string>`(SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)::text
        FROM jsonb_each(CASE WHEN jsonb_typeof(${value}::jsonb) = 'object' THEN ${value}::jsonb ELSE '{}'::jsonb END)
        WHERE key IN (${sql.join(keys)}))`
    : /* kysely-allow-raw: Preserve native member order and duplicate keys in SQLite. */ sql<string>`(SELECT json_group_object(key, CASE type
    WHEN 'object' THEN json(value) WHEN 'array' THEN json(value)
    WHEN 'true' THEN json('true') WHEN 'false' THEN json('false')
    ELSE value END) FROM json_each(${value}) WHERE key IN (${sql.join(keys)}))`;
}

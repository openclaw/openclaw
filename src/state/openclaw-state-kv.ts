import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

export type OpenClawStateKvEntry<TValue = unknown> = {
  scope: string;
  key: string;
  value: TValue;
  updatedAt: number;
};

export type OpenClawStateKvJsonReadResult =
  | { exists: false }
  | { exists: true; value: OpenClawStateJsonValue | undefined; updatedAt: number };

export type OpenClawStateJsonValue =
  | null
  | boolean
  | number
  | string
  | OpenClawStateJsonValue[]
  | { [key: string]: OpenClawStateJsonValue };

type KvRow = {
  scope: string;
  key: string;
  value_json: string;
  updated_at: number | bigint;
};

type OpenClawStateKvDatabase = Pick<OpenClawStateKyselyDatabase, "kv">;

function rowUpdatedAt(row: KvRow): number {
  return typeof row.updated_at === "bigint" ? Number(row.updated_at) : row.updated_at;
}

function parseKvValue(row: KvRow): OpenClawStateJsonValue | undefined {
  try {
    return JSON.parse(row.value_json) as OpenClawStateJsonValue;
  } catch {
    return undefined;
  }
}

function rowToKvEntry<TValue>(row: KvRow): OpenClawStateKvEntry<TValue> | null {
  const value = parseKvValue(row);
  if (value === undefined) {
    return null;
  }
  return {
    scope: row.scope,
    key: row.key,
    value: value as TValue,
    updatedAt: rowUpdatedAt(row),
  };
}

export function readOpenClawStateKvJson(
  scope: string,
  key: string,
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateJsonValue | undefined {
  const result = readOpenClawStateKvJsonResult(scope, key, options);
  return result.exists ? result.value : undefined;
}

export function readOpenClawStateKvJsonResult(
  scope: string,
  key: string,
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateKvJsonReadResult {
  return readOpenClawStateKvJsonResultFromDatabase(openOpenClawStateDatabase(options), scope, key);
}

export function readOpenClawStateKvJsonResultFromDatabase(
  database: OpenClawStateDatabase,
  scope: string,
  key: string,
): OpenClawStateKvJsonReadResult {
  const db = getNodeSqliteKysely<OpenClawStateKvDatabase>(database.db);
  const row =
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("kv")
        .select(["scope", "key", "value_json", "updated_at"])
        .where("scope", "=", scope)
        .where("key", "=", key),
    ) ?? null;
  return row
    ? { exists: true, value: parseKvValue(row), updatedAt: rowUpdatedAt(row) }
    : { exists: false };
}

export function listOpenClawStateKvJson<TValue>(
  scope: string,
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateKvEntry<TValue>[] {
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<OpenClawStateKvDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("kv")
      .select(["scope", "key", "value_json", "updated_at"])
      .where("scope", "=", scope)
      .orderBy("updated_at", "asc")
      .orderBy("key", "asc"),
  ).rows.flatMap((row) => {
    const entry = rowToKvEntry<TValue>(row);
    return entry ? [entry] : [];
  });
}

export function writeOpenClawStateKvJson<TValue>(
  scope: string,
  key: string,
  value: TValue,
  options: OpenClawStateDatabaseOptions & { now?: () => number } = {},
): OpenClawStateKvEntry<TValue> {
  const updatedAt = options.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    writeOpenClawStateKvJsonInTransaction(database, scope, key, value, updatedAt);
  }, options);
  return {
    scope,
    key,
    value,
    updatedAt,
  };
}

export function writeOpenClawStateKvJsonInTransaction<TValue>(
  database: OpenClawStateDatabase,
  scope: string,
  key: string,
  value: TValue,
  updatedAt: number = Date.now(),
): OpenClawStateKvEntry<TValue> {
  const db = getNodeSqliteKysely<OpenClawStateKvDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("kv")
      .values({ scope, key, value_json: JSON.stringify(value), updated_at: updatedAt })
      .onConflict((conflict) =>
        conflict.columns(["scope", "key"]).doUpdateSet({
          value_json: JSON.stringify(value),
          updated_at: updatedAt,
        }),
      ),
  );
  return {
    scope,
    key,
    value,
    updatedAt,
  };
}

export function deleteOpenClawStateKvJson(
  scope: string,
  key: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return runOpenClawStateWriteTransaction((database) => {
    return deleteOpenClawStateKvJsonInTransaction(database, scope, key);
  }, options);
}

export function deleteOpenClawStateKvJsonInTransaction(
  database: OpenClawStateDatabase,
  scope: string,
  key: string,
): boolean {
  const db = getNodeSqliteKysely<OpenClawStateKvDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    db.deleteFrom("kv").where("scope", "=", scope).where("key", "=", key),
  );
  return Number(result.numAffectedRows ?? 0) > 0;
}

export function deleteOpenClawStateKvScope(
  scope: string,
  options: OpenClawStateDatabaseOptions = {},
): number {
  return runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<OpenClawStateKvDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("kv").where("scope", "=", scope),
    );
    return Number(result.numAffectedRows ?? 0);
  }, options);
}

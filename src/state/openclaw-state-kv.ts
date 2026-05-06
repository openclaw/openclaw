import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

export type OpenClawStateKvEntry<TValue = unknown> = {
  scope: string;
  key: string;
  value: TValue;
  updatedAt: number;
};

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
  const database = openOpenClawStateDatabase(options);
  const row =
    (database.db
      .prepare(
        `
          SELECT scope, key, value_json, updated_at
          FROM kv
          WHERE scope = ? AND key = ?
        `,
      )
      .get(scope, key) as KvRow | undefined) ?? null;
  return row ? parseKvValue(row) : undefined;
}

export function listOpenClawStateKvJson<TValue>(
  scope: string,
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateKvEntry<TValue>[] {
  const database = openOpenClawStateDatabase(options);
  return (
    database.db
      .prepare(
        `
          SELECT scope, key, value_json, updated_at
          FROM kv
          WHERE scope = ?
          ORDER BY updated_at ASC, key ASC
        `,
      )
      .all(scope) as KvRow[]
  ).flatMap((row) => {
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
    database.db
      .prepare(
        `
          INSERT INTO kv (scope, key, value_json, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(scope, key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(scope, key, JSON.stringify(value), updatedAt);
  }, options);
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
    const result = database.db
      .prepare("DELETE FROM kv WHERE scope = ? AND key = ?")
      .run(scope, key);
    return Number(result.changes ?? 0) > 0;
  }, options);
}

export function deleteOpenClawStateKvScope(
  scope: string,
  options: OpenClawStateDatabaseOptions = {},
): number {
  return runOpenClawStateWriteTransaction((database) => {
    const result = database.db.prepare("DELETE FROM kv WHERE scope = ?").run(scope);
    return Number(result.changes ?? 0);
  }, options);
}

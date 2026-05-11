import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

type DiagnosticEventsDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;

export type DiagnosticEventEntry<TValue = unknown> = {
  scope: string;
  key: string;
  value: TValue;
  createdAt: number;
};

function parseDiagnosticValue(row: {
  scope: string;
  event_key: string;
  payload_json: string;
  created_at: number | bigint;
}): DiagnosticEventEntry | null {
  try {
    return {
      scope: row.scope,
      key: row.event_key,
      value: JSON.parse(row.payload_json) as unknown,
      createdAt: typeof row.created_at === "bigint" ? Number(row.created_at) : row.created_at,
    };
  } catch {
    return null;
  }
}

export function listDiagnosticEvents<TValue>(
  scope: string,
  options: OpenClawStateDatabaseOptions = {},
): DiagnosticEventEntry<TValue>[] {
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<DiagnosticEventsDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("diagnostic_events")
      .select(["scope", "event_key", "payload_json", "created_at"])
      .where("scope", "=", scope)
      .orderBy("created_at", "asc")
      .orderBy("event_key", "asc"),
  ).rows.flatMap((row) => {
    const entry = parseDiagnosticValue(row);
    return entry ? [entry as DiagnosticEventEntry<TValue>] : [];
  });
}

export function writeDiagnosticEvent<TValue>(
  scope: string,
  key: string,
  value: TValue,
  options: OpenClawStateDatabaseOptions & { now?: () => number } = {},
): DiagnosticEventEntry<TValue> {
  const createdAt = options.now?.() ?? Date.now();
  const payloadJson = JSON.stringify(value);
  if (payloadJson === undefined) {
    throw new Error("diagnostic event value must be JSON serializable");
  }
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<DiagnosticEventsDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("diagnostic_events")
        .values({
          scope,
          event_key: key,
          payload_json: payloadJson,
          created_at: createdAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["scope", "event_key"]).doUpdateSet({
            payload_json: payloadJson,
            created_at: createdAt,
          }),
        ),
    );
  }, options);
  return {
    scope,
    key,
    value,
    createdAt,
  };
}

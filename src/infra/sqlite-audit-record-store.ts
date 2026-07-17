// Shared SQLite storage for append-only diagnostic audit records.
import type { DatabaseSync } from "node:sqlite";
import { sql, type Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type DiagnosticEventsTable = OpenClawStateKyselyDatabase["diagnostic_events"];
type AuditRecordDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;
type DiagnosticEventRow = Pick<
  Selectable<DiagnosticEventsTable>,
  "event_key" | "payload_json" | "created_at"
>;

// diagnostic_events has ordinary SQLite rowids. They preserve append order across
// timestamp ties; event_key is record identity and must not determine chronology.
const auditInsertionSequence =
  /* kysely-allow-raw: hidden rowid is the table's append-order tie breaker. */ sql<number>`rowid`;

type SqliteAuditRecordEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
};

function getAuditRecordKysely(database: DatabaseSync) {
  return getNodeSqliteKysely<AuditRecordDatabase>(database);
}

function parseAuditRecord<T>(row: DiagnosticEventRow): SqliteAuditRecordEntry<T> {
  return {
    key: row.event_key,
    value: JSON.parse(row.payload_json) as T,
    createdAt: row.created_at,
  };
}

function countAuditRecords(database: DatabaseSync, scope: string): number {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getAuditRecordKysely(database)
      .selectFrom("diagnostic_events")
      .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
      .where("scope", "=", scope),
  );
  return typeof row?.count === "bigint" ? Number(row.count) : (row?.count ?? 0);
}

function pruneAuditRecords(params: {
  database: DatabaseSync;
  scope: string;
  maxEntries: number;
  protectedKey?: string;
}): void {
  const overflow = countAuditRecords(params.database, params.scope) - params.maxEntries;
  if (overflow <= 0) {
    return;
  }
  const protectedKey = params.protectedKey;
  const candidates = getAuditRecordKysely(params.database)
      .selectFrom("diagnostic_events")
      .select("event_key")
      .where("scope", "=", params.scope)
      .$if(protectedKey !== undefined, (query) =>
        query.where("event_key", "!=", protectedKey),
      )
      .orderBy("created_at", "asc")
      .orderBy(auditInsertionSequence, "asc")
      .limit(overflow);
  const rows = executeSqliteQuerySync(params.database, candidates).rows;
  for (const row of rows) {
    executeSqliteQuerySync(
      params.database,
      getAuditRecordKysely(params.database)
        .deleteFrom("diagnostic_events")
        .where("scope", "=", params.scope)
        .where("event_key", "=", row.event_key),
    );
  }
}

/** Opens one bounded append-only audit scope in the shared state database. */
export function createSqliteAuditRecordStore<T>(
  options: OpenClawStateDatabaseOptions & { scope: string; maxEntries: number },
) {
  const scope = options.scope;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries));
  function prepareRecord(record: SqliteAuditRecordEntry<T>): DiagnosticEventRow {
    const payloadJson = JSON.stringify(record.value);
    if (payloadJson === undefined) {
      throw new Error(`Audit record ${scope}/${record.key} is not JSON-serializable`);
    }
    return {
      event_key: record.key,
      payload_json: payloadJson,
      created_at: record.createdAt,
    };
  }

  function insertRecord(database: DatabaseSync, record: DiagnosticEventRow): void {
    executeSqliteQuerySync(
      database,
      getAuditRecordKysely(database)
        .insertInto("diagnostic_events")
        .values({
          scope,
          event_key: record.event_key,
          payload_json: record.payload_json,
          created_at: record.created_at,
        })
        .onConflict((conflict) => conflict.columns(["scope", "event_key"]).doNothing()),
    );
  }

  return {
    register(key: string, value: T, createdAt = Date.now()): void {
      const record = prepareRecord({ key, value, createdAt });
      runOpenClawStateWriteTransaction((database) => {
        insertRecord(database.db, record);
        // Audit retention is scope-local. Keep the just-written row and evict the oldest
        // prior rows in the same synchronous commit section.
        pruneAuditRecords({
          database: database.db,
          scope,
          maxEntries,
          protectedKey: key,
        });
      }, options);
    },
    registerMany(records: readonly SqliteAuditRecordEntry<T>[]): void {
      const prepared = records.map(prepareRecord);
      if (prepared.length === 0) {
        return;
      }
      // Legacy imports can contain tens of thousands of rows. Serialize first,
      // then commit every insert and the single retention pass synchronously.
      runOpenClawStateWriteTransaction((database) => {
        for (const record of prepared) {
          insertRecord(database.db, record);
        }
        pruneAuditRecords({ database: database.db, scope, maxEntries });
      }, options);
    },
    size(): number {
      return countAuditRecords(openOpenClawStateDatabase(options).db, scope);
    },
    entries(): SqliteAuditRecordEntry<T>[] {
      const database = openOpenClawStateDatabase(options);
      return executeSqliteQuerySync(
        database.db,
        getAuditRecordKysely(database.db)
          .selectFrom("diagnostic_events")
          .select(["event_key", "payload_json", "created_at"])
          .where("scope", "=", scope)
          .orderBy("created_at", "asc")
          .orderBy(auditInsertionSequence, "asc"),
      ).rows.map((row) => parseAuditRecord<T>(row));
    },
  };
}

// Shared SQLite storage for bounded diagnostic audit records.
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "./kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "./sqlite-number.js";

type DiagnosticEventsTable = OpenClawStateKyselyDatabase["diagnostic_events"];
type AuditRecordDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;
type DiagnosticEventRow = Pick<
  Selectable<DiagnosticEventsTable>,
  "event_key" | "payload_json" | "created_at" | "sequence"
>;
export type PreparedSqliteAuditRecord = Omit<DiagnosticEventRow, "sequence">;

const LEGACY_AUDIT_SEQUENCE_BASE = Number.MIN_SAFE_INTEGER;

export const diagnosticReadOperations = {
  "diagnostic.configAuditFacts": (
    input: { scope: string; lastSeenAuditSequence: number },
    db: DatabaseSync,
  ) => {
    const store = createSqliteAuditRecordKernel<{ event: string }>(db, {
      scope: input.scope,
      maxEntries: 1,
    });
    let auditSequence = 0;
    let beforeSequence: number | undefined;
    let recentExternalEdit = false;
    while (true) {
      const page = store.latest({
        limit: 5,
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
      });
      if (beforeSequence === undefined) {
        auditSequence = page[0]?.sequence ?? 0;
      }
      if (page.length === 0) {
        break;
      }
      let reachedWatermark = false;
      for (const entry of page) {
        if (entry.sequence <= input.lastSeenAuditSequence) {
          reachedWatermark = true;
          break;
        }
        if (entry.value.event === "config.external") {
          recentExternalEdit = true;
        }
      }
      if (reachedWatermark || page.length < 5) {
        break;
      }
      const nextBeforeSequence = page.at(-1)?.sequence;
      if (nextBeforeSequence === undefined || nextBeforeSequence === beforeSequence) {
        break;
      }
      beforeSequence = nextBeforeSequence;
    }
    return { type: "diagnostic.configAuditFacts" as const, auditSequence, recentExternalEdit };
  },

  "diagnostic.latest": (
    input: { scope: string; limit: number; beforeSequence?: number },
    db: DatabaseSync,
  ) => ({
    type: "diagnostic.latest" as const,
    entries: createSqliteAuditRecordKernel<unknown>(db, {
      scope: input.scope,
      maxEntries: 1,
    }).latest(input),
  }),
};

export type SqliteAuditRecordEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
};

export type SequencedSqliteAuditRecordEntry<T> = SqliteAuditRecordEntry<T> & {
  sequence: number;
};

function getAuditRecordKysely(database: DatabaseSync) {
  return getNodeSqliteKysely<AuditRecordDatabase>(database);
}

function parseAuditRecord<T>(row: DiagnosticEventRow): SequencedSqliteAuditRecordEntry<T> {
  return {
    key: row.event_key,
    value: JSON.parse(row.payload_json) as T, // SAFETY: Payloads retain the store's existing generic JSON contract.
    createdAt: row.created_at,
    sequence: row.sequence,
  };
}

function readAuditWriteState(params: {
  database: DatabaseSync;
  scope: string;
  legacy: boolean;
  key?: string;
}): { nextSequence: number; count: number; keyExists: boolean } {
  const row = executeSqliteQueryTakeFirstSync(
    params.database,
    getAuditRecordKysely(params.database)
      .selectFrom("diagnostic_events")
      .select((eb) => [
        eb.fn
          .max<number>("sequence")
          .filterWhere("sequence", params.legacy ? "<" : ">=", 0)
          .as("sequence"),
        eb.fn.countAll<number | bigint>().as("count"),
        eb.fn
          .countAll<number | bigint>()
          .filterWhere("event_key", "=", params.key ?? "")
          .as("keyCount"),
      ])
      .where("scope", "=", params.scope),
  );
  const current = row?.sequence ?? (params.legacy ? LEGACY_AUDIT_SEQUENCE_BASE : 0);
  const next = current + 1;
  if (!Number.isSafeInteger(next) || (params.legacy && next >= 0)) {
    throw new Error(`Audit sequence exhausted for scope ${params.scope}`);
  }
  return {
    nextSequence: next,
    count: sqliteNumber(row?.count ?? 0),
    keyExists: sqliteNumber(row?.keyCount ?? 0) > 0,
  };
}

function pruneAuditRecords(params: {
  database: DatabaseSync;
  scope: string;
  maxEntries: number;
  count: number;
  protectedKey?: string;
}): void {
  const overflow = params.count - params.maxEntries;
  if (overflow <= 0) {
    return;
  }
  const protectedKey = params.protectedKey;
  const baseCandidates = getAuditRecordKysely(params.database)
    .selectFrom("diagnostic_events")
    .select("event_key")
    .where("scope", "=", params.scope);
  const candidates = (
    protectedKey === undefined
      ? baseCandidates
      : baseCandidates.where("event_key", "!=", protectedKey)
  )
    .orderBy("sequence", "asc")
    .limit(overflow);
  executeSqliteQuerySync(
    params.database,
    getAuditRecordKysely(params.database)
      .deleteFrom("diagnostic_events")
      .where("scope", "=", params.scope)
      .where("event_key", "in", candidates),
  );
}

export function prepareSqliteAuditRecord<T>(
  scope: string,
  record: SqliteAuditRecordEntry<T>,
): PreparedSqliteAuditRecord {
  const payloadJson = JSON.stringify(record.value);
  if (payloadJson === undefined) {
    throw new Error(`Audit record ${scope}/${record.key} is not JSON-serializable`);
  }
  return { event_key: record.key, payload_json: payloadJson, created_at: record.createdAt };
}

type AuditRecordInsert = DiagnosticEventRow & { scope: string };

function createAuditRecordInsert(database: DatabaseSync) {
  return prepareSqliteQuerySync<AuditRecordInsert>(database, (parameter) =>
    getAuditRecordKysely(database)
      .insertInto("diagnostic_events")
      .values({
        scope: parameter((record) => record.scope),
        event_key: parameter((record) => record.event_key),
        payload_json: parameter((record) => record.payload_json),
        created_at: parameter((record) => record.created_at),
        sequence: parameter((record) => record.sequence),
      })
      .onConflict((conflict) => conflict.columns(["scope", "event_key"]).doNothing()),
  );
}

const auditRecordInsert = createSqliteQueryCache(createAuditRecordInsert);

/** Connection-bound operations; mutation callers retain the complete transaction. */
export function createSqliteAuditRecordKernel<T>(
  database: DatabaseSync,
  options: { scope: string; maxEntries: number },
) {
  const scope = options.scope;
  const maxEntries = options.maxEntries;
  const prune = (count: number, protectedKey?: string) =>
    pruneAuditRecords({ database, scope, maxEntries, count, protectedKey });
  const selectEntries = () =>
    getAuditRecordKysely(database)
      .selectFrom("diagnostic_events")
      .select(["event_key", "payload_json", "created_at", "sequence"])
      .where("scope", "=", scope);
  function insertRecord(record: DiagnosticEventRow): number {
    return Number(auditRecordInsert(database)({ ...record, scope }).numAffectedRows ?? 0);
  }

  function upsertPreparedRecord(record: PreparedSqliteAuditRecord): void {
    const state = readAuditWriteState({ database, scope, legacy: false, key: record.event_key });
    executeSqliteQuerySync(
      database,
      getAuditRecordKysely(database)
        .insertInto("diagnostic_events")
        .values({
          scope,
          event_key: record.event_key,
          payload_json: record.payload_json,
          created_at: record.created_at,
          sequence: state.nextSequence,
        })
        .onConflict((conflict) =>
          conflict.columns(["scope", "event_key"]).doUpdateSet({
            payload_json: record.payload_json,
            created_at: record.created_at,
            // Updates retain their sequence because reordering keyed state changes retention age.
          }),
        ),
    );
    prune(state.count + (state.keyExists ? 0 : 1), record.event_key);
  }

  function deleteRecord(key: string): void {
    executeSqliteQuerySync(
      database,
      getAuditRecordKysely(database)
        .deleteFrom("diagnostic_events")
        .where("scope", "=", scope)
        .where("event_key", "=", key),
    );
  }

  return {
    register(record: PreparedSqliteAuditRecord): void {
      const state = readAuditWriteState({ database, scope, legacy: false });
      const inserted = insertRecord({
        ...record,
        sequence: state.nextSequence,
      });
      // Keep the just-addressed key while pruning the oldest rows in this scope.
      prune(state.count + inserted, record.event_key);
    },
    upsert: upsertPreparedRecord,
    delete: deleteRecord,
    compareAndSet(
      key: string,
      expectedPayloadJson: string | null | undefined,
      record: PreparedSqliteAuditRecord | null,
    ): boolean {
      const current = executeSqliteQueryTakeFirstSync(
        database,
        getAuditRecordKysely(database)
          .selectFrom("diagnostic_events")
          .select("payload_json")
          .where("scope", "=", scope)
          .where("event_key", "=", key),
      );
      if ((current?.payload_json ?? null) !== expectedPayloadJson) {
        return false;
      }
      if (record) {
        upsertPreparedRecord(record);
      } else {
        deleteRecord(key);
      }
      return true;
    },
    registerLegacyMany(records: readonly PreparedSqliteAuditRecord[]): void {
      const state = readAuditWriteState({ database, scope, legacy: true });
      let sequence = state.nextSequence;
      let count = state.count;
      for (const record of records) {
        count += insertRecord({ ...record, sequence });
        sequence += 1;
      }
      prune(count);
    },
    entries(): SqliteAuditRecordEntry<T>[] {
      return executeSqliteQuerySync(database, selectEntries().orderBy("sequence", "asc")).rows.map(
        (row) => {
          const { sequence: _sequence, ...entry } = parseAuditRecord<T>(row);
          return entry;
        },
      );
    },
    latest(params: {
      limit: number;
      beforeSequence?: number;
    }): SequencedSqliteAuditRecordEntry<T>[] {
      const baseQuery = selectEntries();
      const query =
        params.beforeSequence === undefined
          ? baseQuery
          : baseQuery.where("sequence", "<", params.beforeSequence);
      return executeSqliteQuerySync(
        database,
        query.orderBy("sequence", "desc").limit(params.limit),
      ).rows.map((row) => parseAuditRecord<T>(row));
    },
  };
}

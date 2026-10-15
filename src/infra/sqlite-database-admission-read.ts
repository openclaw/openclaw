import type { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import {
  isPostgresSqlConnection,
  sqlPublicationAnchor,
  type PostgresSqlConnection,
} from "./sql-connection.js";
import {
  isSqliteDatabaseAdmissionFactCurrent as valid,
  readSqliteDatabaseFactRevision,
  readSqliteDatabaseGeneration,
  type Admission,
  type SqliteDatabaseAdmissionKey,
  type StagedAdmissionFact,
} from "./sqlite-database-admission-record.js";
import { getSqliteNativeAdmissionFacts } from "./sqlite-native-admission.js";

/** Admission lookups consume the owning registry and transaction-local state. */
export function createSqliteDatabaseAdmissionReader(owner: {
  state: {
    suspended: WeakSet<DatabaseSync>;
    local: WeakMap<DatabaseSync, Map<string, StagedAdmissionFact>>;
    ddlRevisions: WeakMap<DatabaseSync, number>;
    schemaDirty: WeakSet<DatabaseSync>;
    rolledBack: WeakSet<DatabaseSync>;
    misses: WeakMap<Admission, Map<string, number>>;
  };
  admission: (database: DatabaseSync, create?: boolean) => Admission | undefined;
  pathAdmission: (location: string) => Admission | undefined;
  exchange: (record: Admission) => void;
  publishFact: <T>(
    record: Admission,
    key: SqliteDatabaseAdmissionKey<T>,
    value: T,
    revision: number,
  ) => void;
}) {
  const { state, admission, pathAdmission, exchange, publishFact } = owner;
  function getSqliteDatabaseAdmission<T>(
    database: DatabaseSync | PostgresSqlConnection,
    key: SqliteDatabaseAdmissionKey<T>,
    options: { existingOnly?: boolean } = {},
  ): T | undefined {
    const anchor = sqlPublicationAnchor(database);
    if (!anchor.isOpen || state.suspended.has(anchor)) {
      return undefined;
    }
    const record = admission(anchor, options.existingOnly !== true && !database.isTransaction);
    if (!record) {
      return undefined;
    }
    const local =
      (isPostgresSqlConnection(database)
        ? undefined
        : getSqliteNativeAdmissionFacts(database)
      )?.get(key.name) ?? state.local.get(anchor)?.get(key.name);
    if (
      local &&
      local.revision === readSqliteDatabaseFactRevision(record, local.schemaDependent) &&
      (!local.schemaDependent || local.ddlRevision === (state.ddlRevisions.get(anchor) ?? 0))
    ) {
      return key.read(local.value);
    }
    if (key.schemaDependent && state.schemaDirty.has(anchor)) {
      return undefined;
    }
    if (state.rolledBack.has(anchor)) {
      if (database.isTransaction) {
        return undefined;
      }
      state.rolledBack.delete(anchor);
    }
    let fact = record.facts.get(key.name);
    if (!fact || !valid(record, fact)) {
      if (key.writer === "host") {
        if (
          database.isTransaction ||
          threadId === 0 ||
          record.hostRevision === readSqliteDatabaseGeneration(record, "hostRevision")
        ) {
          return undefined;
        }
        exchange(record);
        fact = record.facts.get(key.name);
        return fact && valid(record, fact) ? key.read(fact.value) : undefined;
      }
      const revision = readSqliteDatabaseGeneration(record, "publicationRevision");
      const misses = state.misses.get(record) ?? new Map<string, number>();
      state.misses.set(record, misses);
      if (!database.isTransaction && misses.get(key.name) !== revision) {
        exchange(record);
        fact = record.facts.get(key.name);
        misses.set(key.name, readSqliteDatabaseGeneration(record, "publicationRevision"));
      }
    }
    return fact && valid(record, fact) ? key.read(fact.value) : undefined;
  }

  function getOrLoadSqliteDatabaseAdmissionForPath<T>(
    location: string,
    key: SqliteDatabaseAdmissionKey<T>,
    load: () => T | undefined,
  ): T | undefined {
    const record = pathAdmission(location);
    const fact = record?.facts.get(key.name);
    const cached = record && fact && valid(record, fact) ? key.read(fact.value) : undefined;
    if (cached !== undefined) {
      return cached;
    }
    const generation = record
      ? readSqliteDatabaseFactRevision(record, key.schemaDependent)
      : undefined;
    const value = load();
    if (record && generation !== undefined && value !== undefined) {
      publishFact(record, key, value, generation);
    }
    return value;
  }
  return { getSqliteDatabaseAdmission, getOrLoadSqliteDatabaseAdmissionForPath };
}

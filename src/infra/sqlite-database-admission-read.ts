import type { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import {
  isPostgresSqlConnection,
  sqlPublicationAnchor,
  type EngineConnection,
  type PostgresSqlConnection,
} from "./sql-connection.js";
import {
  isSqliteDatabaseAdmissionFactCurrent as valid,
  hasSqliteDatabaseSchemaAdmission,
  readSqliteDatabaseFactRevision,
  readSqliteDatabaseGeneration,
  readSqliteDatabaseAdmissionFact,
  admitSqliteDatabaseFactValue,
  type Admission,
  type AdmissionFactValue,
  type SqliteDatabaseAdmissionKey,
  type StagedAdmissionFact,
  type SqliteDatabaseAdmissionRegistry,
} from "./sqlite-database-admission-record.js";
import { getSqliteNativeAdmissionFacts } from "./sqlite-native-admission.js";
import type { DatabaseFileIdentity } from "./sqlite-worker-identity.js";

/** Admission lookups consume the owning registry and transaction-local state. */
export function createSqliteDatabaseAdmissionReader(owner: {
  state: {
    registry: SqliteDatabaseAdmissionRegistry;
    suspended: WeakSet<DatabaseSync>;
    local: WeakMap<DatabaseSync, Map<string, StagedAdmissionFact>>;
    ddlRevisions: WeakMap<DatabaseSync, number>;
    schemaDirty: WeakSet<DatabaseSync>;
    rolledBack: WeakSet<DatabaseSync>;
    misses: WeakMap<Admission, Map<string, number>>;
    openedIdentities: WeakMap<DatabaseSync, string>;
    localSchemaRevisions: Map<string, number>;
  };
  admission: (database: DatabaseSync, create?: boolean) => Admission | undefined;
  pathAdmission: (location: string) => Admission | undefined;
  exchange: (record: Admission) => void;
  retain: (record: Admission) => void;
  release: (record: Admission) => void;
  publishFact: <T>(
    record: Admission,
    key: SqliteDatabaseAdmissionKey<T>,
    value: AdmissionFactValue,
    revision: number,
  ) => void;
}) {
  const { state, admission, pathAdmission, exchange, retain, release, publishFact } = owner;

  function withPathAdmission<T>(
    location: string,
    operation: (record: Admission | undefined) => T,
  ): T {
    const record = pathAdmission(location);
    if (!record) {
      return operation(undefined);
    }
    try {
      retain(record);
      return operation(record);
    } finally {
      release(record);
    }
  }
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
      return readSqliteDatabaseAdmissionFact(local, key);
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
        return fact && valid(record, fact) ? readSqliteDatabaseAdmissionFact(fact, key) : undefined;
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
    return fact && valid(record, fact) ? readSqliteDatabaseAdmissionFact(fact, key) : undefined;
  }

  function getOrLoadSqliteDatabaseAdmissionForPath<T>(
    location: string,
    key: SqliteDatabaseAdmissionKey<T>,
    load: () => T | undefined,
  ): T | undefined {
    const read = (record: Admission | undefined): T | undefined => {
      if (!record) {
        return load();
      }
      const fact = record.facts.get(key.name);
      const cached =
        fact && valid(record, fact) ? readSqliteDatabaseAdmissionFact(fact, key) : undefined;
      if (cached !== undefined) {
        return cached;
      }
      const generation = readSqliteDatabaseFactRevision(record, key.schemaDependent);
      const value = load();
      if (value !== undefined) {
        publishFact(record, key, admitSqliteDatabaseFactValue(key, value), generation);
      }
      return value;
    };
    // Physical-fact loaders can close their sole reader; receipt lookups do not end native custody.
    return key.lifetime === "process"
      ? withPathAdmission(location, read)
      : read(pathAdmission(location));
  }

  function getSqliteDatabaseSchemaRevision(
    connection: EngineConnection,
    options: { existingOnly?: boolean } = {},
  ): number | undefined {
    const database = sqlPublicationAnchor(connection);
    const record = admission(database, options.existingOnly !== true);
    if (record) {
      return readSqliteDatabaseGeneration(record, "schemaRevision");
    }
    const fileIdentity = state.openedIdentities.get(database);
    return fileIdentity ? (state.localSchemaRevisions.get(fileIdentity) ?? 0) : undefined;
  }

  function hasSqliteDatabaseSchemaAdmissionForPath(location: string): boolean {
    return hasSqliteDatabaseSchemaAdmission(pathAdmission(location));
  }

  /** Admission owns the descriptor's immutable identity; callers do not re-stat its pathname. */
  function getSqliteDatabaseAdmissionIdentityForPath(
    location: string,
  ): DatabaseFileIdentity | undefined {
    return state.registry.forLocation(location)?.physicalIdentity;
  }

  /** Consume the already captured physical identity without another filesystem lookup. */
  function hasSqliteDatabaseSchemaAdmissionForIdentity(
    physicalIdentity: DatabaseFileIdentity,
  ): boolean {
    return state.registry.hasSchemaAdmissionForIdentity(physicalIdentity);
  }

  return {
    getSqliteDatabaseAdmission,
    getSqliteDatabaseSchemaRevision,
    getOrLoadSqliteDatabaseAdmissionForPath,
    hasSqliteDatabaseSchemaAdmissionForPath,
    getSqliteDatabaseAdmissionIdentityForPath,
    hasSqliteDatabaseSchemaAdmissionForIdentity,
  };
}

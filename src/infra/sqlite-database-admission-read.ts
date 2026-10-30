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
  SqliteDatabaseGenerationSlot,
  admitSqliteDatabaseFactValue,
  type Admission,
  type AdmissionFactValue,
  type SqliteDatabaseFactKey,
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
    key: SqliteDatabaseFactKey<T>,
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
    key: SqliteDatabaseFactKey<T>,
    options: { existingOnly?: boolean; refresh?: boolean } = {},
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
    // A retry may have physical facts while later schema publications are still in transit.
    if (!fact || !valid(record, fact) || (options.refresh && key.writer !== "host")) {
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
      if (
        key.writer !== "connection" &&
        !database.isTransaction &&
        (options.refresh || misses.get(key.name) !== revision)
      ) {
        exchange(record);
        fact = record.facts.get(key.name);
        misses.set(key.name, readSqliteDatabaseGeneration(record, "publicationRevision"));
      }
    }
    return fact && valid(record, fact) ? readSqliteDatabaseAdmissionFact(fact, key) : undefined;
  }

  function getOrLoadSqliteDatabaseAdmissionForPath<T>(
    location: string,
    key: SqliteDatabaseFactKey<T>,
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

  /** Optional preparation consumes only facts already delivered to this isolate. */
  function peekSqliteDatabaseAdmissionForPath<T>(
    location: string,
    key: SqliteDatabaseFactKey<T>,
  ): T | undefined {
    const record = state.registry.forLocation(location);
    const fact = record?.facts.get(key.name);
    return record && fact && valid(record, fact)
      ? readSqliteDatabaseAdmissionFact(fact, key)
      : undefined;
  }

  /** Retain revision cells while following the owner's current publication. */
  function prepareSqliteDatabaseAdmissionForPath<T>(
    location: string,
    key: SqliteDatabaseFactKey<T>,
  ): () => T | undefined {
    const record = pathAdmission(location);
    if (!record) {
      return () => undefined;
    }
    const generation = new Int32Array(record.generation);
    const revisionSlot = key.schemaDependent
      ? SqliteDatabaseGenerationSlot.schemaRevision
      : SqliteDatabaseGenerationSlot.factRevision;
    let fact = record.facts.get(key.name);
    let current = fact && new Int32Array(fact.current);
    return () => {
      if (Atomics.load(generation, SqliteDatabaseGenerationSlot.retired) !== 0) {
        return undefined;
      }
      const published = record.facts.get(key.name);
      if (published !== fact) {
        fact = published;
        current = fact && new Int32Array(fact.current);
      }
      return fact &&
        current &&
        Atomics.load(current, 0) === 1 &&
        fact.revision === Atomics.load(generation, revisionSlot)
        ? readSqliteDatabaseAdmissionFact(fact, key)
        : undefined;
    };
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
    peekSqliteDatabaseAdmissionForPath,
    prepareSqliteDatabaseAdmissionForPath,
    hasSqliteDatabaseSchemaAdmissionForPath,
    getSqliteDatabaseAdmissionIdentityForPath,
    hasSqliteDatabaseSchemaAdmissionForIdentity,
  };
}

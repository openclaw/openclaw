import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  executeWithCachedStatement,
  registerNodeSqliteDisposeCallback,
} from "./kysely-sync-cache-state.js";
import {
  beginSqliteDatabaseAdmissionOperation,
  beginSqliteDatabaseWrite,
  discardSqliteDatabaseTransactionAdmissions,
  getSqliteDatabaseAdmission,
  getSqliteDatabaseSchemaRevision,
  finishSqliteDatabaseWrite,
  invalidateLocalSqliteSchemaAdmissions,
  publishSqliteDatabaseAdmission,
  publishSqliteDatabaseSchemaChange,
  readSqliteDatabaseWriteRevision,
  suspendSqliteDatabaseAdmission,
} from "./sqlite-database-admission.js";
import {
  observeSqliteNativeClose,
  observeSqliteNativeOperations,
  type NativeSqlite,
} from "./sqlite-native-observer.js";
import { getSqlitePinnedReadSnapshot } from "./sqlite-pinned-read-snapshot.js";
import {
  captureTrackedSqliteSchemaFacts as captureFacts,
  invalidateTrackedSqliteSchemaFacts as invalidate,
  schemaAdmission,
  type SqliteSchemaFacts,
} from "./sqlite-schema-admission.js";
import { observeSchemaLifetime } from "./sqlite-schema-lifetime.js";
import { canPreserveTransactionSnapshot } from "./sqlite-schema-mutation.js";
import {
  finishSqliteReadScope,
  observeSqliteTransactionState as observeTransactionState,
  type SqliteSchemaOwner as SchemaOwner,
  type SchemaMutationListener,
  type SqliteReadOperationRevision,
  type SqliteReadScopeRevision,
} from "./sqlite-schema-scope.js";
import {
  prepareSqliteTempTrackingSchema,
  type SqliteTempTrackingSchema,
} from "./sqlite-temp-generation-schema.js";

export type { SqliteSchemaFacts } from "./sqlite-schema-admission.js";
export type {
  SqliteReadOperationRevision,
  SqliteReadScopeRevision,
} from "./sqlite-schema-scope.js";

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSchemaFacts"),
  () => new WeakMap<DatabaseSync, SchemaOwner>(),
);

/** Schema publications outside DDL (such as a deferred version marker) share this revision. */
export function invalidateSqliteSchemaFacts(database: DatabaseSync): void {
  invalidateSchemaFacts(database, true);
}

function invalidateSchemaFacts(
  database: DatabaseSync,
  publish: boolean,
  change: "main" | "temp" | "local" | "rollback" = "main",
  notify = change !== "temp",
): void {
  const owner = owners.get(database);
  if (owner) {
    const changesMain = change === "main";
    owner.isolatedTempTables.clear();
    if (database.isTransaction) {
      owner.transactionMutationRevision = undefined;
    }
    if (changesMain) {
      invalidateLocalSqliteSchemaAdmissions(database);
    }
    if (changesMain && database.isTransaction && !owner.transactionalSchema) {
      owner.transactionBaseFacts = owner.facts;
    }
    if (notify) {
      for (const listener of owner.mutationListeners ?? []) {
        listener(undefined);
      }
    }
    invalidate(owner);
    owner.transactionalSchema ||= changesMain && database.isTransaction;
    owner.transactionalTempSchema ||= change === "temp" && database.isTransaction;
    owner.pendingSchema ||= changesMain && owner.nativeDepth > 0;
    if (publish && changesMain && !database.isTransaction && owner.nativeDepth === 0) {
      publishSqliteDatabaseSchemaChange(database);
    }
  }
}

/** MAIN mutations and rollback revoke before execution; TEMP DDL only revokes local facts. */
export function registerSqliteSchemaMutationListener(
  database: DatabaseSync,
  listener: SchemaMutationListener,
): () => void {
  const owner = owners.get(database);
  if (!owner) {
    throw new Error("SQLite schema observation requires a tracked connection");
  }
  const listeners = (owner.mutationListeners ??= new Set());
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fixed tracking shapes retain local facts; other TEMP DDL still expires its connection's facts. */
export function installSqliteTempTrackingSchema(
  database: DatabaseSync,
  schema: SqliteTempTrackingSchema,
): void {
  const owner = owners.get(database);
  if (!owner?.admitted || owner.authorizerActive || !owner.installTempTrackingSchema) {
    throw new Error("SQLite tracking requires admitted schema facts");
  }
  owner.installTempTrackingSchema(schema);
}

function trackSchemaChanges(
  database: DatabaseSync,
  owner: SchemaOwner,
  native: NativeSqlite,
  writable: boolean,
): void {
  const settle = (boundary = false, rolledBack = false) => {
    if (rolledBack) {
      const snapshot = getSqlitePinnedReadSnapshot(database);
      const facts =
        snapshot && (owner.transactionalSchema ? owner.transactionBaseFacts : owner.facts);
      discardSqliteDatabaseTransactionAdmissions(database);
      invalidate(owner);
      owner.transactionalSchema = false;
      owner.transactionalTempSchema = false;
      owner.transactionalFacts = false;
      if (snapshot && owner.admitted && !owner.authorizerActive) {
        // A still-active native read cursor keeps its old catalog locally until the pin ends.
        owner.facts = facts
          ? { ...facts, revision: owner.revision }
          : captureFacts(database, owner);
        owner.snapshot = snapshot;
        owner.qualifiedSnapshot = snapshot;
      }
      owner.transactionBaseFacts = undefined;
      return;
    }
    if (
      (boundary || !database.isTransaction) &&
      (owner.transactionalSchema || owner.transactionalTempSchema || owner.transactionalFacts)
    ) {
      if (owner.transactionalSchema) {
        // A local first-use writer must publish to already-admitted sibling connections.
        publishSqliteDatabaseSchemaChange(database);
      }
      invalidate(owner);
      // A batch may commit one transaction and leave another containing DDL open.
      owner.transactionalSchema &&= database.isTransaction;
      owner.transactionalTempSchema &&= database.isTransaction;
      owner.transactionalFacts = false;
    }
  };
  const execute = observeSqliteNativeOperations(database, native, (mutation, phase) => {
    if (owner.settling) {
      return { finish: () => {} };
    }
    const { control, dataChange } = mutation;
    // The parser proves these batches contain only outer rollback plus ordinary reads.
    const schemaChange = control?.outerRollback === true ? false : mutation.schemaChange;
    const mainSchemaChange = mutation.mainSchemaChange && control?.outerRollback !== true;
    observeTransactionState(database, owner);
    const snapshot = phase === "bind" ? undefined : getSqlitePinnedReadSnapshot(database);
    const iterator = phase !== "bind" && !snapshot && !owner.capturing ? {} : undefined;
    const newSnapshot = snapshot && snapshot !== owner.snapshot && !owner.capturing;
    if (newSnapshot) {
      if (!owner.transactionCatalogBound && database.isTransaction && owner.transactionRead) {
        invalidate(owner);
        owner.transactionalFacts = true;
      } else {
        // The pin marker precedes its first native step. Adopt committed facts now;
        // only subsequent operations may preserve this pin's historical catalog.
        observeSchemaLifetime(database, owner, undefined);
        if (!owner.facts && !owner.transactionalSchema) {
          const retained = getSqliteDatabaseAdmission(database, schemaAdmission);
          if (retained) {
            owner.facts = { ...retained, revision: owner.revision };
          }
        }
      }
      owner.snapshot = snapshot;
      owner.qualifiedSnapshot = snapshot;
    }
    if (owner.nativeDepth === 0) {
      settle();
    }
    const wasTransaction = database.isTransaction;
    if (
      writable &&
      !wasTransaction &&
      (control?.kind === "BEGIN" || control?.kind === "SAVEPOINT")
    ) {
      // Discover the physical admission before SQLite holds a transaction lock.
      getSqliteDatabaseSchemaRevision(database);
    }
    const openingMutationRevision =
      !wasTransaction && control?.kind === "BEGIN" && control.single
        ? owner.mutationRevision
        : undefined;
    if (!wasTransaction && control?.kind === "BEGIN" && owner.admitted) {
      getAdmittedSqliteSchemaFacts(database);
    }
    const expiresRead =
      Boolean(control) && !canPreserveTransactionSnapshot(control, wasTransaction);
    const rollback = control?.kind === "ROLLBACK";
    const rollsBackSchema = rollback && owner.transactionalSchema && !control.outerRollback;
    // Row-only rollback expires reads without revoking schema-based authority.
    const notifySchema =
      (schemaChange && !mutation.temporaryTableSchemaChange) ||
      (rollback && owner.transactionalSchema);
    const schemaInvalidation =
      mainSchemaChange || rollsBackSchema
        ? "main"
        : rollback
          ? owner.transactionalTempSchema && !owner.transactionalSchema
            ? "temp"
            : "rollback"
          : mutation.temporaryTableSchemaChange
            ? "temp"
            : "local";
    if (rollback) {
      discardSqliteDatabaseTransactionAdmissions(database);
    }
    if (schemaChange || rollback) {
      invalidateSchemaFacts(database, false, schemaInvalidation, notifySchema);
    }
    if (dataChange || mutation.temporaryTableSchemaChange || control?.kind === "ROLLBACK") {
      owner.mutationRevision += 1;
    }
    if (control?.kind === "ROLLBACK") {
      owner.rollbackRevision += 1;
    }
    if (
      phase !== "bind" &&
      wasTransaction &&
      !control &&
      owner.readDepth === 0 &&
      !owner.transactionCatalogBound
    ) {
      // SQLite has no public txn_state API here. A raw read might have established a
      // historical snapshot; only a local catalog capture can qualify it afterward.
      owner.transactionRead = true;
    }
    const changesReadScope = schemaChange || dataChange || control !== undefined;
    const temporaryWrite = mutation.temporaryWriteTables?.every((table) =>
      owner.isolatedTempTables.has(table),
    );
    if ((dataChange && !temporaryWrite) || mainSchemaChange) {
      beginSqliteDatabaseWrite(database, mainSchemaChange || owner.nativeDepth > 0);
    }
    // Writer admission can throw before a native operation owns the matching decrement.
    if (changesReadScope) {
      owner.mutationDepth += 1;
    }
    owner.nativeDepth += 1;
    const finishAdmissions = beginSqliteDatabaseAdmissionOperation(database);
    const pendingBefore = owner.schemaMutationRevision;
    if (mainSchemaChange) {
      owner.schemaMutationRevision += 1;
    }
    owner.pendingSchema ||= mainSchemaChange;
    if (iterator) {
      owner.unmanagedSnapshots.add(iterator);
    }
    return {
      stepped: () => {
        if (
          database.isTransaction &&
          !control &&
          !owner.transactionRead &&
          !owner.transactionCatalogBound &&
          owner.facts &&
          owner.processRevision === getSqliteDatabaseSchemaRevision(database)
        ) {
          owner.transactionCatalogBound = true;
        }
      },
      finish: (succeeded, abandoned) => {
        if (iterator && owner.unmanagedSnapshots.delete(iterator) && owner.iteratorFacts) {
          invalidate(owner);
          owner.iteratorFacts = false;
        }
        finishAdmissions();
        owner.nativeDepth -= 1;
        if (changesReadScope) {
          owner.mutationDepth -= 1;
        }
        if (!database.isOpen) {
          return;
        }
        if (schemaChange || rollback) {
          if (rollback) {
            discardSqliteDatabaseTransactionAdmissions(database);
          }
          invalidateSchemaFacts(database, false, schemaInvalidation, notifySchema);
        }
        const rolledBack =
          succeeded &&
          wasTransaction &&
          control?.outerRollback === true &&
          !database.isTransaction &&
          !mainSchemaChange &&
          owner.schemaMutationRevision === pendingBefore;
        if (rolledBack) {
          settle(false, true);
          owner.pendingSchema = false;
        }
        if (owner.nativeDepth === 0) {
          owner.settling = true;
          try {
            const changedSchema = owner.pendingSchema || owner.transactionalSchema;
            if (
              !rolledBack &&
              owner.pendingSchema &&
              !database.isTransaction &&
              !owner.transactionalSchema
            ) {
              publishSqliteDatabaseSchemaChange(database);
            }
            if (!rolledBack) {
              settle(expiresRead);
            }
            if (changedSchema && !database.isTransaction && !rolledBack) {
              // Native errors may roll back callback DDL or follow committed batch DDL.
              // Both require the actual settled catalog, never an intermediate capture.
              invalidate(owner);
              if (!succeeded) {
                discardSqliteDatabaseTransactionAdmissions(database);
              }
              if (owner.admitted && !owner.authorizerActive && !abandoned) {
                getAdmittedSqliteSchemaFacts(database);
                owner.transactionBaseFacts = undefined;
              }
            }
            owner.pendingSchema = false;
          } finally {
            owner.settling = false;
          }
        }
        finishSqliteReadScope(
          database,
          owner,
          wasTransaction,
          expiresRead,
          succeeded,
          openingMutationRevision,
        );
        // A parked read cursor cannot retain custody of a settled sibling statement's write.
        if (owner.mutationDepth === 0 && !database.isTransaction) {
          finishSqliteDatabaseWrite(database);
        }
        // A control batch may open a transaction and read before returning, even on error.
        owner.transactionRead ||= database.isTransaction && Boolean(control && !control.single);
      },
    };
  });
  observeSqliteNativeClose(database, () => {
    finishSqliteDatabaseWrite(database);
  });
  owner.installTempTrackingSchema = (schema) => {
    const { sql, unexpected } = prepareSqliteTempTrackingSchema(database, schema);
    try {
      // sqlite-allow-raw -- The schema owner generates only declared connection-local shapes.
      execute(() => native.DatabaseSync.prototype.exec.call(database, sql), {
        schemaChange: unexpected,
        mainSchemaChange: unexpected,
        temporaryTableSchemaChange: false,
        // Known generation triggers change no rows and must not revoke in-flight reads.
        dataChange: unexpected || schema.kind !== "generation",
        temporaryWriteTables: [],
        control: undefined,
      });
      if (!unexpected && schema.kind === "transcript-index") {
        for (const table of [schema.statusTable, schema.pendingTable]) {
          owner.isolatedTempTables.add(table.toLowerCase());
        }
      }
    } catch (error) {
      invalidateSqliteSchemaFacts(database);
      throw error;
    }
  };
  if (typeof database.setAuthorizer === "function") {
    database.setAuthorizer = (callback) => {
      native.DatabaseSync.prototype.setAuthorizer.call(database, callback);
      owner.authorizerActive = callback !== null;
      suspendSqliteDatabaseAdmission(database, owner.authorizerActive);
      invalidate(owner);
    };
  }
  registerNodeSqliteDisposeCallback(database, () => {
    invalidate(owner);
    owner.readRevision = undefined;
    owner.transactionSnapshot = undefined;
    // Native close can still fail; transaction settlement retains pending DDL publication.
  });
}

/** Local mutation witness; committed sibling writes use the physical admission revision. */
export function readSqliteNativeMutationRevision(database: DatabaseSync): number | undefined {
  return owners.get(database)?.mutationRevision;
}

/** A callback inside native SQL cannot retain a token across that statement's rollback. */
export function readSqliteRollbackRevision(database: DatabaseSync): number | undefined {
  const owner = owners.get(database);
  if (!owner) {
    return undefined;
  }
  observeTransactionState(database, owner);
  return owner.mutationDepth === 0 ? owner.rollbackRevision : undefined;
}

/** Derived caches may retain reads from a tracked transaction until its first mutation. */
export function hasUncommittedSqliteWrites(database: DatabaseSync): boolean {
  const owner = owners.get(database);
  if (owner) {
    observeTransactionState(database, owner);
  }
  return (
    !owner ||
    owner.authorizerActive ||
    owner.mutationDepth > 0 ||
    owner.unmanagedSnapshots.size > 0 ||
    getSqlitePinnedReadSnapshot(database) !== undefined ||
    (database.isTransaction &&
      (owner.transactionMutationRevision === undefined ||
        owner.transactionMutationRevision !== owner.mutationRevision))
  );
}

/** Reuse schema only through unchanged synchronous transaction work, never as write authority. */
export function canReuseSqliteSchemaInTransaction(database: DatabaseSync): boolean {
  const owner = owners.get(database);
  return owner !== undefined && !owner.authorizerActive && database.isTransaction;
}

/** Reuse row facts only inside admitted reads, never during a native write or snapshot. */
export function getSqliteReadOperationRevision(
  database: DatabaseSync,
): SqliteReadOperationRevision | undefined {
  if (database.isTransaction || getSqlitePinnedReadSnapshot(database)) {
    return undefined;
  }
  const revision = getSqliteReadScopeRevision(database);
  return revision?.snapshot === undefined ? revision : undefined;
}

/** Stable identity for row facts in the admitted operation's current SQLite snapshot. */
export function getSqliteReadScopeRevision(
  database: DatabaseSync,
): SqliteReadScopeRevision | undefined {
  const owner = owners.get(database);
  if (owner) {
    observeTransactionState(database, owner);
  }
  if (
    !owner?.admitted ||
    !owner.facts ||
    owner.authorizerActive ||
    owner.readDepth === 0 ||
    owner.mutationDepth !== 0 ||
    owner.unmanagedSnapshots.size > 0
  ) {
    return undefined;
  }
  const snapshot =
    getSqlitePinnedReadSnapshot(database) ??
    (database.isTransaction ? (owner.transactionSnapshot ??= {}) : undefined);
  const previous = owner.readRevision;
  if (snapshot) {
    if (
      previous?.schema === owner.facts &&
      previous.snapshot === snapshot &&
      previous.mutationRevision === owner.mutationRevision
    ) {
      return previous;
    }
    return (owner.readRevision = {
      schema: owner.facts,
      mutationRevision: owner.mutationRevision,
      snapshot,
      writeRevision: undefined,
    });
  }
  const writeRevision = readSqliteDatabaseWriteRevision(database);
  if (writeRevision === undefined) {
    return undefined;
  }
  if (
    previous?.schema === owner.facts &&
    previous.snapshot === undefined &&
    previous.writeRevision === writeRevision &&
    previous.mutationRevision === owner.mutationRevision
  ) {
    return previous;
  }
  return (owner.readRevision = {
    schema: owner.facts,
    snapshot: undefined,
    writeRevision,
    mutationRevision: owner.mutationRevision,
  });
}

/** Reuse row facts only inside an admitted synchronous operation. */
export function runSqliteReadOperationSync<T>(database: DatabaseSync, operation: () => T): T {
  const owner = owners.get(database);
  if (!owner || owner.authorizerActive) {
    return operation();
  }
  owner.readDepth += 1;
  try {
    if (owner.admitted) {
      getAdmittedSqliteSchemaFacts(database);
    }
    return operation();
  } finally {
    owner.readDepth -= 1;
  }
}

/** Explicit offline verification only; runtime caches use owning-writer receipts. */
export function readSqliteDataVersion(database: DatabaseSync): number {
  const row = executeWithCachedStatement(database, "PRAGMA data_version", [], (statement) =>
    statement.get(),
  );
  if (typeof row?.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
}

/** Install at native open, before callers can retain statements or install an authorizer. */
export function trackSqliteSchema(
  database: DatabaseSync,
  native: NativeSqlite,
  writable = true,
): void {
  if (!owners.has(database)) {
    const owner: SchemaOwner = {
      admitted: false,
      revision: 0,
      readDepth: 0,
      mutationRevision: 0,
      rollbackRevision: 0,
      mutationDepth: 0,
      transactionOpen: database.isOpen && database.isTransaction,
      transactionRead: false,
      transactionCatalogBound: false,
      nativeDepth: 0,
      pendingSchema: false,
      schemaMutationRevision: 0,
      settling: false,
      capturing: false,
      transactionalSchema: false,
      transactionalTempSchema: false,
      transactionalFacts: false,
      authorizerActive: false,
      unmanagedSnapshots: new Set(),
      isolatedTempTables: new Set(),
      iteratorFacts: false,
    };
    owners.set(database, owner);
    trackSchemaChanges(database, owner, native, writable);
    const retained = getSqliteDatabaseAdmission(database, schemaAdmission, { existingOnly: true });
    if (retained) {
      owner.admitted = true;
      owner.facts = { ...retained, revision: owner.revision };
      owner.processRevision = getSqliteDatabaseSchemaRevision(database);
    }
  }
}

/** Select first ordinary admission without querying or authorizing a connection. */
export function isSqliteSchemaAdmissionCold(database: DatabaseSync): boolean {
  const owner = owners.get(database);
  return Boolean(owner && !owner.admitted && !owner.authorizerActive);
}

/** Admission retains schema facts; its header validator must stay synchronous and read-free. */
export function admitSqliteSchema(
  database: DatabaseSync,
  validateUserVersion?: (userVersion: number) => void,
): void {
  const owner = owners.get(database);
  if (!owner) {
    throw new Error("SQLite schema admission requires a connection tracked from native open");
  }
  owner.admitted = true;
  getAdmittedSqliteSchemaFacts(database, validateUserVersion);
}

/** Match transferred proof against the schema owner's current admitted catalog. */
export function adoptSqliteSchemaFacts(database: DatabaseSync, facts: SqliteSchemaFacts): boolean {
  const owner = owners.get(database);
  if (
    !owner ||
    owner.authorizerActive ||
    database.isTransaction ||
    owner.unmanagedSnapshots.size > 0
  ) {
    return false;
  }
  owner.admitted = true;
  const current = getAdmittedSqliteSchemaFacts(database);
  return (
    current !== undefined &&
    current.schemaVersion === facts.schemaVersion &&
    current.userVersion === facts.userVersion
  );
}

/** Consume the physical database's admitted facts and owner-published schema changes. */
export function getAdmittedSqliteSchemaFacts(
  database: DatabaseSync,
  validateUserVersion?: (userVersion: number) => void,
): SqliteSchemaFacts | undefined {
  const owner = owners.get(database);
  // Dynamic authorizer decisions cannot be represented by a cached schema result.
  if (!owner?.admitted || owner.authorizerActive) {
    return undefined;
  }
  const snapshot = getSqlitePinnedReadSnapshot(database);
  const unknownSnapshot =
    (database.isTransaction && owner.transactionRead && !owner.transactionCatalogBound) ||
    owner.unmanagedSnapshots.size > 0;
  const scopeChanged = observeSchemaLifetime(database, owner, snapshot);
  if (!owner.facts) {
    owner.snapshot = snapshot;
    // Managed operations refresh on their next admission. Unmanaged snapshots and
    // sibling publications observed inside a transaction cannot outlive that snapshot.
    owner.transactionalFacts ||= database.isTransaction && (owner.readDepth === 0 || scopeChanged);
    const localSnapshot = unknownSnapshot || Boolean(snapshot) || owner.transactionalSchema;
    const retained =
      owner.transactionalSchema || localSnapshot
        ? undefined
        : getSqliteDatabaseAdmission(database, schemaAdmission);
    if (retained) {
      validateUserVersion?.(retained.userVersion);
      owner.facts = { ...retained, revision: owner.revision };
      return owner.facts;
    }
    const schemaRevision = getSqliteDatabaseSchemaRevision(database);
    owner.facts = captureFacts(database, owner, validateUserVersion);
    owner.iteratorFacts ||= owner.unmanagedSnapshots.size > 0;
    owner.qualifiedSnapshot = snapshot;
    owner.transactionCatalogBound ||= database.isTransaction;
    if (!localSnapshot) {
      // A sibling can publish DDL while this capture holds an older WAL snapshot.
      publishSqliteDatabaseAdmission(database, schemaAdmission, owner.facts, { schemaRevision });
    }
  } else {
    validateUserVersion?.(owner.facts.userVersion);
  }
  return owner.facts;
}

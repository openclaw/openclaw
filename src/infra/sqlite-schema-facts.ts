import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  executeWithCachedStatement,
  registerNodeSqliteDisposeCallback,
} from "./kysely-sync-cache-state.js";
import {
  getSqlitePinnedReadSnapshot,
  readChangedSqliteSchemaMarkers,
  readSqliteVersionObservation,
  runSqlitePinnedReadSnapshotSync,
  type SqliteSchemaMarkers,
} from "./sqlite-pinned-read-snapshot.js";
import { findSqlCharacter, normalizeSqlWhitespace } from "./sqlite-schema-sql.js";
import {
  prepareSqliteTempTrackingSchema,
  type SqliteTempTrackingSchema,
} from "./sqlite-temp-generation-schema.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type NativeSqlite = Pick<typeof import("node:sqlite"), "DatabaseSync" | "StatementSync">;

export type SqliteSchemaFacts = {
  readonly revision: number;
  readonly userVersion: number;
  readonly schemaVersion: number;
  readonly tables: ReadonlySet<string>;
  readonly tableSql: ReadonlyMap<string, string | null>;
  readonly indexes: ReadonlySet<string>;
  readonly triggers: ReadonlyMap<string, { table: string; sql: string | null }>;
};

type SchemaMutationListener = (observed?: SqliteSchemaMarkers) => void;

type SchemaOwner = {
  admitted: boolean;
  revision: number;
  facts?: SqliteSchemaFacts;
  dataVersion?: number;
  observedDataVersion?: number;
  readDepth: number;
  readDataVersion?: number;
  mutationRevision: number;
  mutationDepth: number;
  transactionOpen: boolean;
  readRevision?: SqliteReadScopeRevision;
  transactionalSchema: boolean;
  transactionalTempSchema: boolean;
  transactionalFacts: boolean;
  snapshot?: object;
  authorizerActive: boolean;
  scope?: SchemaScope;
  scopeRevision?: number;
  mutationListeners?: Set<SchemaMutationListener>;
  installTempTrackingSchema?: (schema: SqliteTempTrackingSchema) => void;
};

type SchemaScope = { key?: string; revision: number; users: number };

const scopes = resolveGlobalSingleton(Symbol.for("openclaw.sqliteSchemaScopes"), () => {
  const byIdentity = new Map<string, SchemaScope>();
  const release = (scope: SchemaScope) => {
    scope.users -= 1;
    if (scope.users === 0 && scope.key && byIdentity.get(scope.key) === scope) {
      byIdentity.delete(scope.key);
    }
  };
  return { byIdentity, release, finalizer: new FinalizationRegistry(release) };
});

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSchemaFacts"),
  () => new WeakMap<DatabaseSync, SchemaOwner>(),
);

function invalidate(owner: SchemaOwner): void {
  owner.revision += 1;
  owner.facts = undefined;
}

function notifySchemaMutation(owner: SchemaOwner, observed?: SqliteSchemaMarkers): void {
  for (const listener of owner.mutationListeners ?? []) {
    listener(observed);
  }
}

function observeTransactionState(database: DatabaseSync, owner: SchemaOwner): void {
  const inTransaction = database.isTransaction;
  if (owner.transactionOpen !== inTransaction) {
    owner.readDataVersion = undefined;
    if (owner.transactionOpen) {
      // A read error can roll back SQLite without passing through a tracked write.
      owner.mutationRevision += 1;
    }
    owner.transactionOpen = inTransaction;
  }
}

function bindScope(database: DatabaseSync, owner: SchemaOwner): SchemaScope {
  if (owner.scope) {
    return owner.scope;
  }
  const location = database.location();
  const key = location ? readDatabasePathIdentitySync(location).key : undefined;
  const scope = (key && scopes.byIdentity.get(key)) || { key, revision: 0, users: 0 };
  if (key) {
    scopes.byIdentity.set(key, scope);
  }
  scope.users += 1;
  owner.scope = scope;
  owner.scopeRevision = scope.revision;
  scopes.finalizer.register(database, scope, owner);
  return scope;
}

function publishSchemaChange(database: DatabaseSync, owner: SchemaOwner): void {
  const scope = bindScope(database, owner);
  scope.revision += 1;
  owner.scopeRevision = scope.revision;
}

/** Schema publications outside DDL (such as a deferred version marker) share this revision. */
export function invalidateSqliteSchemaFacts(database: DatabaseSync): void {
  const owner = owners.get(database);
  if (owner) {
    notifySchemaMutation(owner);
    // Capture physical identity before DDL, while the caller owns cleanup on admission failure.
    bindScope(database, owner);
    invalidate(owner);
    owner.transactionalSchema ||= database.isTransaction;
    if (!database.isTransaction) {
      publishSchemaChange(database, owner);
    }
  }
}

/** MAIN mutations revoke before execution; TEMP-only table changes expire local facts instead. */
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

// Conservative matching also covers multi-statement migration batches and catalog repairs.
// False positives only revoke prepared facts; SQL is still executed by SQLite unchanged.
function changesSchema(sql: string): boolean | "temp" {
  if (
    !/\b(?:CREATE|ALTER|DROP|REINDEX|VACUUM)\b|\bPRAGMA\b[\s\S]*\b(?:user_version|schema_version|writable_schema)\b[\s\S]*[=(]/i.test(
      sql,
    )
  ) {
    return false;
  }
  return changesOnlyTemporaryTable(sql) ? "temp" : true;
}

function changesOnlyTemporaryTable(sql: string): boolean {
  const normalized = normalizeSqlWhitespace(sql);
  const end = findSqlCharacter(normalized, ";");
  if (end >= 0 && normalized.slice(end + 1).trim() !== "") {
    return false;
  }
  // An unqualified DROP may resolve to MAIN; only the explicit TEMP namespace is local.
  return (
    /^CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\b/iu.test(normalized) ||
    /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:temp|"temp"|`temp`|\[temp\])\s*\./iu.test(normalized)
  );
}

// A write to another table can change policy through a trigger.
function changesData(sql: string): boolean {
  return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
}

const transactionControlPrefix =
  /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)*(BEGIN|SAVEPOINT|COMMIT|END|RELEASE|ROLLBACK)\b/i;

type SqliteTransactionControl = { kind: string; single: boolean };

function batchTransactionControl(sql: string): SqliteTransactionControl | undefined {
  let control: string | undefined;
  let statements = 0;
  let remaining = sql;
  while (remaining) {
    if (remaining.trim()) {
      statements += 1;
    }
    const next = transactionControlPrefix.exec(remaining)?.[1]?.toUpperCase();
    if (next === "ROLLBACK") {
      control = next;
    }
    control ||= next;
    // Exec accepts batches; quoted semicolons and comments do not start statements.
    const end = remaining.includes(";") ? findSqlCharacter(remaining, ";") : -1;
    if (end < 0) {
      break;
    }
    remaining = remaining.slice(end + 1);
  }
  return control ? { kind: control, single: statements === 1 } : undefined;
}

function canPreserveTransactionSnapshot(
  control: SqliteTransactionControl | undefined,
  inTransaction: boolean,
): boolean {
  return Boolean(
    inTransaction &&
    control?.single &&
    (control.kind === "SAVEPOINT" || control.kind === "RELEASE" || control.kind === "ROLLBACK"),
  );
}

function callStatement<Result>(
  method: {
    (...parameters: SQLInputValue[]): Result;
    (named: Record<string, SQLInputValue>, ...parameters: SQLInputValue[]): Result;
  },
  [first, ...remaining]: [(SQLInputValue | Record<string, SQLInputValue>)?, ...SQLInputValue[]],
): Result {
  if (first === undefined) {
    return method();
  }
  if (typeof first === "object" && first !== null && !ArrayBuffer.isView(first)) {
    return method(first, ...remaining);
  }
  return method(first, ...remaining);
}

function trackSchemaChanges(
  database: DatabaseSync,
  owner: SchemaOwner,
  native: NativeSqlite,
): void {
  const settle = (boundary = false) => {
    if (
      (boundary || !database.isTransaction) &&
      (owner.transactionalSchema || owner.transactionalTempSchema || owner.transactionalFacts)
    ) {
      if (owner.transactionalSchema) {
        // A local first-use writer must publish to already-admitted sibling connections.
        publishSchemaChange(database, owner);
      }
      invalidate(owner);
      // A batch may commit one transaction and leave another containing DDL open.
      owner.transactionalSchema &&= database.isTransaction;
      owner.transactionalTempSchema &&= database.isTransaction;
      owner.transactionalFacts = false;
    }
  };
  const finishReadScope = (wasTransaction: boolean, expiresRead: boolean, succeeded: boolean) => {
    const inTransaction = database.isTransaction;
    if (expiresRead || wasTransaction !== inTransaction) {
      owner.readDataVersion = undefined;
    }
    if (!succeeded && wasTransaction && !inTransaction) {
      owner.mutationRevision += 1;
    }
    owner.transactionOpen = inTransaction;
  };
  const beginMutation = (
    schemaChange: boolean | "temp",
    control: SqliteTransactionControl | undefined,
    dataChange: boolean,
  ) => {
    observeTransactionState(database, owner);
    if (owner.transactionalSchema && !owner.scope) {
      bindScope(database, owner);
    }
    // An implicit rollback may be followed by BEGIN before the next schema read.
    settle();
    const wasTransaction = database.isTransaction;
    const expiresRead =
      Boolean(control) && !canPreserveTransactionSnapshot(control, wasTransaction);
    const invalidatesMain =
      schemaChange === true || (control?.kind === "ROLLBACK" && owner.transactionalSchema);
    const invalidatesTemp =
      schemaChange === "temp" || (control?.kind === "ROLLBACK" && owner.transactionalTempSchema);
    const invalidateMutation = () => {
      if (invalidatesMain) {
        invalidateSqliteSchemaFacts(database);
      } else if (invalidatesTemp) {
        // TEMP shadowing expires this connection's facts, not siblings' MAIN admission.
        invalidate(owner);
        owner.transactionalTempSchema ||= database.isTransaction;
      }
    };
    invalidateMutation();
    if (dataChange || schemaChange === "temp" || control?.kind === "ROLLBACK") {
      // TEMP shadowing and savepoint rollback can change row reads without a data write.
      owner.mutationRevision += 1;
    }
    if (expiresRead) {
      owner.readDataVersion = undefined;
    }
    // Native callbacks in a control batch can cross several SQLite snapshots.
    const changesReadScope = schemaChange || dataChange || control !== undefined;
    if (changesReadScope) {
      owner.mutationDepth += 1;
    }
    return (succeeded: boolean) => {
      if (changesReadScope) {
        owner.mutationDepth -= 1;
      }
      // A failed batch can already have changed schema; rollback can reuse SQLite's cookie.
      invalidateMutation();
      settle(Boolean(control));
      // Batches can probe an intermediate snapshot; implicit rollback also ends admission.
      finishReadScope(wasTransaction, expiresRead, succeeded);
    };
  };
  const execute = <T>(
    operation: () => T,
    schemaChange: boolean | "temp",
    control: SqliteTransactionControl | undefined,
    dataChange: boolean,
  ): T => {
    const finish = beginMutation(schemaChange, control, dataChange);
    let succeeded = false;
    try {
      const result = operation();
      succeeded = true;
      return result;
    } finally {
      finish(succeeded);
    }
  };
  owner.installTempTrackingSchema = (schema) => {
    const { sql, unexpected } = prepareSqliteTempTrackingSchema(database, schema);
    try {
      // No suppression scope: native callbacks still execute through the ordinary observer.
      // sqlite-allow-raw -- The schema owner generates only the declared connection-local tracking shapes.
      execute(
        () => native.DatabaseSync.prototype.exec.call(database, sql),
        unexpected,
        undefined,
        true,
      );
    } catch (error) {
      // A failed batch may have installed only part of the declared schema.
      invalidateSqliteSchemaFacts(database);
      throw error;
    }
  };
  // Keep native prototype instrumentation visible after a connection or statement is retained.
  database.exec = (sql) =>
    execute(
      () => native.DatabaseSync.prototype.exec.call(database, sql),
      changesSchema(sql),
      batchTransactionControl(sql),
      changesData(sql),
    );
  database.prepare = (...prepareArgs) => {
    const [sql] = prepareArgs;
    const statement = native.DatabaseSync.prototype.prepare.call(database, ...prepareArgs);
    const schemaChange = changesSchema(sql);
    const controlKind = transactionControlPrefix.exec(sql)?.[1]?.toUpperCase();
    const control = controlKind ? { kind: controlKind, single: true } : undefined;
    const dataChange = changesData(sql);
    if (schemaChange || control || dataChange) {
      const run = Object.hasOwn(statement, "run") ? statement.run.bind(statement) : undefined;
      const get = Object.hasOwn(statement, "get") ? statement.get.bind(statement) : undefined;
      const all = Object.hasOwn(statement, "all") ? statement.all.bind(statement) : undefined;
      const iterate = Object.hasOwn(statement, "iterate")
        ? statement.iterate.bind(statement)
        : undefined;
      const wrap =
        <Result>(resolve: () => Parameters<typeof callStatement<Result>>[0]) =>
        (...bindings: Parameters<typeof callStatement<Result>>[1]): Result =>
          execute(() => callStatement(resolve(), bindings), schemaChange, control, dataChange);
      statement.run = wrap(() => run ?? native.StatementSync.prototype.run.bind(statement));
      statement.get = wrap(() => get ?? native.StatementSync.prototype.get.bind(statement));
      statement.all = wrap(() => all ?? native.StatementSync.prototype.all.bind(statement));
      statement.iterate = function* (...bindings) {
        const finish = beginMutation(schemaChange, control, dataChange);
        let succeeded = false;
        try {
          const rows = callStatement(
            iterate ?? native.StatementSync.prototype.iterate.bind(statement),
            bindings,
          );
          try {
            yield* rows;
            succeeded = true;
          } catch (error) {
            // Delegation does not close the native iterator when next() throws.
            try {
              rows.return?.();
            } catch {
              // Preserve the statement failure over a failed native reset.
            }
            throw error;
          }
        } finally {
          finish(succeeded);
        }
        return undefined;
      };
    }
    return statement;
  };
  if (typeof database.setAuthorizer === "function") {
    database.setAuthorizer = (callback) => {
      native.DatabaseSync.prototype.setAuthorizer.call(database, callback);
      owner.authorizerActive = callback !== null;
      invalidate(owner);
    };
  }
  registerNodeSqliteDisposeCallback(database, () => {
    invalidate(owner);
    owner.dataVersion = undefined;
    owner.observedDataVersion = undefined;
    owner.readDataVersion = undefined;
    owner.readRevision = undefined;
    // Native close can still fail; transaction settlement retains pending DDL publication.
    if (owner.scope) {
      scopes.finalizer.unregister(owner);
      scopes.release(owner.scope);
      owner.scope = undefined;
      owner.scopeRevision = undefined;
    }
  });
}

export type SqliteReadOperationRevision = {
  schema: SqliteSchemaFacts;
  dataVersion: number;
  mutationRevision: number;
};

export type SqliteReadScopeRevision = Readonly<
  SqliteReadOperationRevision & {
    snapshot: object | undefined;
  }
>;

/** Local mutation witness only; foreign writers still require their owning admission fence. */
export function readSqliteNativeMutationRevision(database: DatabaseSync): number | undefined {
  return owners.get(database)?.mutationRevision;
}

/** SQL-free witness for a dedicated, unpinned foreign-commit observer. */
export function readSqliteForeignObservationRevision(database: DatabaseSync): number | undefined {
  const owner = owners.get(database);
  if (!owner || owner.authorizerActive || owner.mutationDepth !== 0) {
    return undefined;
  }
  return owner.mutationRevision;
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
  return getSqliteReadScopeRevision(database);
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
    owner.readDataVersion === undefined ||
    owner.readDataVersion !== owner.observedDataVersion ||
    owner.mutationDepth !== 0
  ) {
    return undefined;
  }
  const snapshot = getSqlitePinnedReadSnapshot(database);
  const previous = owner.readRevision;
  if (
    previous?.schema === owner.facts &&
    previous.dataVersion === owner.readDataVersion &&
    previous.mutationRevision === owner.mutationRevision &&
    previous.snapshot === snapshot
  ) {
    return previous;
  }
  return (owner.readRevision = {
    schema: owner.facts,
    dataVersion: owner.readDataVersion,
    mutationRevision: owner.mutationRevision,
    snapshot,
  });
}

/** Share freshness only within this synchronous call stack, never across an await. */
export function runSqliteReadOperationSync<T>(
  database: DatabaseSync,
  operation: () => T,
  mode: "cached" | "fresh" = "cached",
): T {
  const owner = owners.get(database);
  if (!owner || owner.authorizerActive) {
    return operation();
  }
  owner.readDepth += 1;
  try {
    // First admission publishes its probe into this scope before validation consumes it.
    if (owner.admitted) {
      owner.readDataVersion = readSqliteCacheDataVersion(database, mode);
    }
    return operation();
  } finally {
    owner.readDepth -= 1;
    if (owner.readDepth === 0) {
      owner.readDataVersion = undefined;
    }
  }
}

/** Always execute a fresh probe; compare versions only on the same connection. */
export function readSqliteDataVersion(database: DatabaseSync): number {
  const row = executeWithCachedStatement(database, "PRAGMA data_version", [], (statement) =>
    statement.get(),
  );
  if (typeof row?.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  const owner = owners.get(database);
  if (owner) {
    owner.observedDataVersion = row.data_version;
  }
  return row.data_version;
}

/** Admission observes foreign commits; explicit fresh reads never reuse an operation's probe. */
export function readSqliteCacheDataVersion(
  database: DatabaseSync,
  mode: "cached" | "fresh" = "cached",
): number {
  const tracked = owners.get(database);
  if (tracked) {
    observeTransactionState(database, tracked);
  }
  const owner = tracked?.admitted ? tracked : undefined;
  if (
    mode === "cached" &&
    owner &&
    !owner.authorizerActive &&
    owner.readDataVersion !== undefined
  ) {
    return owner.readDataVersion;
  }
  const observation =
    owner?.facts && owner.dataVersion !== undefined && !owner.authorizerActive
      ? readSqliteVersionObservation(database, owner.dataVersion)
      : undefined;
  const dataVersion = observation?.dataVersion ?? readSqliteDataVersion(database);
  if (owner) {
    owner.observedDataVersion = dataVersion;
    if (owner.dataVersion !== dataVersion) {
      const facts = owner.facts;
      // Data commits preserve schema-derived caches; compare both markers in one snapshot.
      const changed = facts && readChangedSqliteSchemaMarkers(database, facts, observation);
      if (!facts || changed) {
        if (changed) {
          notifySchemaMutation(owner, changed);
        }
        invalidate(owner);
      }
      owner.dataVersion = dataVersion;
    }
    if (mode === "cached" && owner.readDepth > 0 && !owner.authorizerActive) {
      owner.readDataVersion = dataVersion;
    }
  }
  return dataVersion;
}

/** Install at native open, before callers can retain statements or install an authorizer. */
export function trackSqliteSchema(database: DatabaseSync, native: NativeSqlite): void {
  if (!owners.has(database)) {
    const owner: SchemaOwner = {
      admitted: false,
      revision: 0,
      readDepth: 0,
      mutationRevision: 0,
      mutationDepth: 0,
      transactionOpen: database.isTransaction,
      transactionalSchema: false,
      transactionalTempSchema: false,
      transactionalFacts: false,
      authorizerActive: false,
    };
    owners.set(database, owner);
    trackSchemaChanges(database, owner, native);
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
  readSqliteCacheDataVersion(database);
  getAdmittedSqliteSchemaFacts(database, validateUserVersion);
}

/** A sibling's facts require this connection's committed schema markers, never its data_version. */
export function adoptSqliteSchemaFacts(database: DatabaseSync, facts: SqliteSchemaFacts): boolean {
  const owner = owners.get(database);
  if (!owner || owner.authorizerActive || database.isTransaction) {
    return false;
  }
  const dataVersion = readSqliteDataVersion(database);
  if (readChangedSqliteSchemaMarkers(database, facts)) {
    return false;
  }
  const snapshot = getSqlitePinnedReadSnapshot(database);
  observeSchemaLifetime(database, owner, snapshot);
  if (
    owner.facts &&
    (owner.facts.schemaVersion !== facts.schemaVersion ||
      owner.facts.userVersion !== facts.userVersion)
  ) {
    invalidate(owner);
  }
  owner.snapshot = snapshot;
  owner.admitted = true;
  owner.dataVersion = dataVersion;
  owner.facts ??= { ...facts, revision: owner.revision };
  return true;
}

function observeSchemaLifetime(
  database: DatabaseSync,
  owner: SchemaOwner,
  snapshot: object | undefined,
): boolean {
  if (owner.snapshot && owner.snapshot !== snapshot) {
    invalidate(owner);
    owner.snapshot = undefined;
  }
  const scope = bindScope(database, owner);
  const scopeChanged = owner.scopeRevision !== scope.revision;
  if (scopeChanged) {
    invalidate(owner);
    owner.scopeRevision = scope.revision;
  }
  if (
    (owner.transactionalSchema || owner.transactionalTempSchema || owner.transactionalFacts) &&
    !database.isTransaction
  ) {
    if (owner.transactionalSchema) {
      publishSchemaChange(database, owner);
    }
    invalidate(owner);
    owner.transactionalSchema = false;
    owner.transactionalTempSchema = false;
    owner.transactionalFacts = false;
  }
  return scopeChanged;
}

/** Consume admitted facts; operation admission owns foreign-commit freshness. */
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
  const scopeChanged = observeSchemaLifetime(database, owner, snapshot);
  if (!owner.facts) {
    owner.snapshot = snapshot;
    // Managed operations refresh on their next admission. Unmanaged snapshots and
    // sibling publications observed inside a transaction cannot outlive that snapshot.
    owner.transactionalFacts ||= database.isTransaction && (owner.readDepth === 0 || scopeChanged);
    owner.facts = runSqlitePinnedReadSnapshotSync(database, (schemaVersion) => {
      const version = executeWithCachedStatement(database, "PRAGMA user_version", [], (s) =>
        s.get(),
      );
      const userVersion = Number(version?.user_version ?? 0);
      // Validate the captured header before catalog errors can mask its refusal.
      validateUserVersion?.(userVersion);
      const objects = executeWithCachedStatement(
        database,
        "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table', 'index', 'trigger')",
        [],
        (s) => s.all(),
      );
      const tables = new Set<string>();
      const tableSql = new Map<string, string | null>();
      const indexes = new Set<string>();
      const triggers = new Map<string, { table: string; sql: string | null }>();
      for (const row of objects) {
        if (typeof row.name !== "string") {
          continue;
        }
        const sql = typeof row.sql === "string" ? row.sql : null;
        if (row.type === "table") {
          tables.add(row.name);
          tableSql.set(row.name, sql);
        } else if (row.type === "index") {
          indexes.add(row.name);
        } else if (row.type === "trigger" && typeof row.tbl_name === "string") {
          triggers.set(row.name, { table: row.tbl_name, sql });
        }
      }
      return {
        revision: owner.revision,
        userVersion,
        schemaVersion,
        tables,
        tableSql,
        indexes,
        triggers,
      };
    });
  } else {
    validateUserVersion?.(owner.facts.userVersion);
  }
  return owner.facts;
}

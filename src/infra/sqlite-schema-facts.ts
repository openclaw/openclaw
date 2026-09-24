import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  executeWithCachedStatement,
  registerNodeSqliteDisposeCallback,
} from "./kysely-sync-cache-state.js";
import {
  getSqlitePinnedReadSnapshot,
  runSqlitePinnedReadSnapshotSync,
} from "./sqlite-pinned-read-snapshot.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type NativeSqlite = Pick<typeof import("node:sqlite"), "DatabaseSync" | "StatementSync">;

export type SqliteSchemaFacts = {
  readonly revision: number;
  readonly userVersion: number;
  readonly schemaVersion: number;
  readonly tables: ReadonlySet<string>;
};

type SchemaOwner = {
  admitted: boolean;
  revision: number;
  facts?: SqliteSchemaFacts;
  dataVersion?: number;
  readDepth: number;
  readDataVersion?: number;
  transactionalSchema: boolean;
  transactionalFacts: boolean;
  snapshot?: object;
  authorizerActive: boolean;
  scope?: SchemaScope;
  scopeRevision?: number;
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
    // Capture physical identity before DDL, while the caller owns cleanup on admission failure.
    bindScope(database, owner);
    invalidate(owner);
    owner.transactionalSchema ||= database.isTransaction;
    if (!database.isTransaction) {
      publishSchemaChange(database, owner);
    }
  }
}

// Conservative matching also covers multi-statement migration batches and catalog repairs.
// False positives only revoke prepared facts; SQL is still executed by SQLite unchanged.
function changesSchema(sql: string): boolean {
  return /\b(?:CREATE|ALTER|DROP|REINDEX|VACUUM)\b|\bPRAGMA\b[\s\S]*\b(?:user_version|schema_version|writable_schema)\b[\s\S]*[=(]/i.test(
    sql,
  );
}

function callStatement<Result>(
  method: {
    (...parameters: SQLInputValue[]): Result;
    (named: Record<string, SQLInputValue>, ...parameters: SQLInputValue[]): Result;
  },
  [first, ...remaining]: [] | [SQLInputValue | Record<string, SQLInputValue>, ...SQLInputValue[]],
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
      (owner.transactionalSchema || owner.transactionalFacts)
    ) {
      if (owner.transactionalSchema) {
        // A local first-use writer must publish to already-admitted sibling connections.
        publishSchemaChange(database, owner);
      }
      invalidate(owner);
      // A batch may commit one transaction and leave another containing DDL open.
      owner.transactionalSchema &&= database.isTransaction;
      owner.transactionalFacts = false;
    }
  };
  const execute = <T>(
    operation: () => T,
    schemaChange: boolean,
    rollback: boolean,
    boundary: boolean,
  ): T => {
    if (owner.transactionalSchema && !owner.scope) {
      bindScope(database, owner);
    }
    // An implicit rollback may be followed by BEGIN before the next schema read.
    settle();
    const invalidates = schemaChange || (rollback && owner.transactionalSchema);
    if (invalidates) {
      invalidateSqliteSchemaFacts(database);
    }
    try {
      return operation();
    } finally {
      // A failed batch can already have changed schema; rollback can reuse SQLite's cookie.
      if (invalidates) {
        invalidateSqliteSchemaFacts(database);
      }
      settle(boundary);
    }
  };
  // Keep native prototype instrumentation visible after a connection or statement is retained.
  database.exec = (sql) =>
    execute(
      () => native.DatabaseSync.prototype.exec.call(database, sql),
      changesSchema(sql),
      /\bROLLBACK\b/i.test(sql),
      /\b(?:BEGIN|SAVEPOINT|COMMIT|END|RELEASE|ROLLBACK)\b/i.test(sql),
    );
  database.prepare = (...prepareArgs) => {
    const [sql] = prepareArgs;
    const statement = native.DatabaseSync.prototype.prepare.call(database, ...prepareArgs);
    const schemaChange = changesSchema(sql);
    const rollback = /\bROLLBACK\b/i.test(sql);
    const boundary = /\b(?:BEGIN|SAVEPOINT|COMMIT|END|RELEASE|ROLLBACK)\b/i.test(sql);
    if (schemaChange || boundary) {
      const run = Object.hasOwn(statement, "run") ? statement.run.bind(statement) : undefined;
      const get = Object.hasOwn(statement, "get") ? statement.get.bind(statement) : undefined;
      const all = Object.hasOwn(statement, "all") ? statement.all.bind(statement) : undefined;
      const iterate = Object.hasOwn(statement, "iterate")
        ? statement.iterate.bind(statement)
        : undefined;
      statement.run = (...bindings) =>
        execute(
          () => callStatement(run ?? native.StatementSync.prototype.run.bind(statement), bindings),
          schemaChange,
          rollback,
          boundary,
        );
      statement.get = (...bindings) =>
        execute(
          () => callStatement(get ?? native.StatementSync.prototype.get.bind(statement), bindings),
          schemaChange,
          rollback,
          boundary,
        );
      statement.all = (...bindings) =>
        execute(
          () => callStatement(all ?? native.StatementSync.prototype.all.bind(statement), bindings),
          schemaChange,
          rollback,
          boundary,
        );
      statement.iterate = function* (...bindings) {
        if (owner.transactionalSchema && !owner.scope) {
          bindScope(database, owner);
        }
        settle();
        const invalidates = schemaChange || (rollback && owner.transactionalSchema);
        if (invalidates) {
          invalidateSqliteSchemaFacts(database);
        }
        try {
          yield* callStatement(
            iterate ?? native.StatementSync.prototype.iterate.bind(statement),
            bindings,
          );
        } finally {
          if (invalidates) {
            invalidateSqliteSchemaFacts(database);
          }
          settle(boundary);
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
    owner.readDataVersion = undefined;
    // Native close can still fail; transaction settlement retains pending DDL publication.
    if (owner.scope) {
      scopes.finalizer.unregister(owner);
      scopes.release(owner.scope);
      owner.scope = undefined;
      owner.scopeRevision = undefined;
    }
  });
}

/** Share freshness only within this synchronous call stack, never across an await. */
export function runSqliteReadOperationSync<T>(database: DatabaseSync, operation: () => T): T {
  const owner = owners.get(database);
  if (!owner?.admitted || owner.authorizerActive) {
    return operation();
  }
  owner.readDepth += 1;
  try {
    return operation();
  } finally {
    owner.readDepth -= 1;
    if (owner.readDepth === 0) {
      owner.readDataVersion = undefined;
    }
  }
}

/** Foreign commits are observed on the next operation; SQLite owns snapshot visibility. */
export function readSqliteCacheDataVersion(database: DatabaseSync): number {
  const tracked = owners.get(database);
  const owner = tracked?.admitted ? tracked : undefined;
  if (owner && !owner.authorizerActive && owner.readDataVersion !== undefined) {
    return owner.readDataVersion;
  }
  const row = executeWithCachedStatement(database, "PRAGMA data_version", [], (statement) =>
    statement.get(),
  );
  if (typeof row?.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  if (owner) {
    if (owner.dataVersion !== row.data_version) {
      invalidate(owner);
      owner.dataVersion = row.data_version;
    }
    if (owner.readDepth > 0 && !owner.authorizerActive) {
      owner.readDataVersion = row.data_version;
    }
  }
  return row.data_version;
}

/** Install at native open, before callers can retain statements or install an authorizer. */
export function trackSqliteSchema(database: DatabaseSync, native: NativeSqlite): void {
  if (!owners.has(database)) {
    const owner: SchemaOwner = {
      admitted: false,
      revision: 0,
      readDepth: 0,
      transactionalSchema: false,
      transactionalFacts: false,
      authorizerActive: false,
    };
    owners.set(database, owner);
    trackSchemaChanges(database, owner, native);
  }
}

/** Only database admission opts a connection into retained schema facts. */
export function admitSqliteSchema(database: DatabaseSync): void {
  const owner = owners.get(database);
  if (!owner) {
    throw new Error("SQLite schema admission requires a connection tracked from native open");
  }
  owner.admitted = true;
  getAdmittedSqliteSchemaFacts(database);
}

/** DDL and foreign commits revoke the admission; ordinary reads consume its recorded facts. */
export function getAdmittedSqliteSchemaFacts(
  database: DatabaseSync,
): SqliteSchemaFacts | undefined {
  const owner = owners.get(database);
  // Dynamic authorizer decisions cannot be represented by a cached schema result.
  if (!owner?.admitted || owner.authorizerActive) {
    return undefined;
  }
  readSqliteCacheDataVersion(database);
  const snapshot = getSqlitePinnedReadSnapshot(database);
  if (owner.snapshot && owner.snapshot !== snapshot) {
    invalidate(owner);
    owner.snapshot = undefined;
  }
  const scope = bindScope(database, owner);
  if (owner.scopeRevision !== scope.revision) {
    invalidate(owner);
    owner.scopeRevision = scope.revision;
  }
  if ((owner.transactionalSchema || owner.transactionalFacts) && !database.isTransaction) {
    if (owner.transactionalSchema) {
      publishSchemaChange(database, owner);
    }
    invalidate(owner);
    owner.transactionalSchema = false;
    owner.transactionalFacts = false;
  }
  if (!owner.facts) {
    owner.snapshot = snapshot;
    owner.transactionalFacts = database.isTransaction;
    owner.facts = runSqlitePinnedReadSnapshotSync(database, () => {
      const userVersion = executeWithCachedStatement(database, "PRAGMA user_version", [], (s) =>
        s.get(),
      );
      const schemaVersion = executeWithCachedStatement(database, "PRAGMA schema_version", [], (s) =>
        s.get(),
      );
      const tables = executeWithCachedStatement(
        database,
        "SELECT name FROM main.sqlite_schema WHERE type = 'table'",
        [],
        (s) => s.all(),
      );
      return {
        revision: owner.revision,
        userVersion: Number(userVersion?.user_version ?? 0),
        schemaVersion: Number(schemaVersion?.schema_version),
        tables: new Set(tables.flatMap((row) => (typeof row.name === "string" ? [row.name] : []))),
      };
    });
  }
  return owner.facts;
}

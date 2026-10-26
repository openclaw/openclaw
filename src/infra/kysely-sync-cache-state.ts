// Shared per-database SQLite execution and Kysely cache state so lifecycle
// owners (sqlite-transaction) can clear caches without value-loading kysely.
// Doctor/setup closures cold-load transaction consumers; keep this file
// independent of the Kysely value graph.
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerListener } from "../shared/listeners.js";
import {
  isPostgresSqlConnection,
  type EngineConnection,
  type SqlStatement,
} from "./sql-connection.js";

export const { kyselyByDatabase, queryErrorHandlerByDatabase } = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteKyselyCacheState"),
  () => ({
    kyselyByDatabase: new WeakMap<DatabaseSync, unknown>(),
    queryErrorHandlerByDatabase: new WeakMap<DatabaseSync, (error: unknown) => void>(),
  }),
);
// Cached statements retain their database. Per-instance lifecycle wrappers clear
// both caches before close, including callers from transformed SDK module graphs.
const statementCacheSymbol = Symbol.for("openclaw.kyselySyncStatementCache");
const statementInvalidationSymbol = Symbol.for("openclaw.kyselySyncStatementInvalidation");
const statementCacheEnabledSymbol = Symbol.for("openclaw.kyselySyncStatementCacheEnabled");
const authorizerActiveSymbol = Symbol.for("openclaw.kyselySyncAuthorizerActive");
const disposeCallbacksSymbol = Symbol.for("openclaw.sqliteDisposeCallbacks");
// Admit up to 4 MiB of SQL plus variable-size bindings per enabled database.
// Candidate SQL and native/JS overhead are additional; retention scales with open handles.
const statementCacheCapacity = 64;
const statementCacheEntryBytes = 64 * 1024;

type SqliteAuthorizer = Parameters<DatabaseSync["setAuthorizer"]>[0];
type SqliteDisposeReason = "close" | "replace";

type StatementCache = {
  statements: Map<string, StatementSync>;
  candidates: Set<string>;
  active: WeakSet<StatementSync>;
};

type StatementCacheOwner = DatabaseSync & {
  [statementCacheSymbol]?: StatementCache;
  [statementInvalidationSymbol]?: true;
  [statementCacheEnabledSymbol]?: true;
  [authorizerActiveSymbol]?: boolean;
  [disposeCallbacksSymbol]?: Set<(reason: SqliteDisposeReason) => void>;
};

/** Node 26.8+ can release bindings without waiting for an unrelated V8 collection. */
export function disposeSqliteStatement(statement: StatementSync & Partial<Disposable>): void {
  // Supported older Node releases and Bun still own finalization through GC/connection close.
  statement[Symbol.dispose]?.();
}

function clearStatementCache(owner: StatementCacheOwner): void {
  const cache = owner[statementCacheSymbol];
  delete owner[statementCacheSymbol];
  if (!cache) {
    return;
  }
  for (const statement of cache.statements.values()) {
    if (!cache.active.has(statement)) {
      disposeSqliteStatement(statement);
    }
  }
}

/** Retire dependent native resources before this connection closes or is replaced. */
export function registerNodeSqliteDisposeCallback(
  db: DatabaseSync,
  callback: (reason: SqliteDisposeReason) => void,
): () => void {
  const owner: StatementCacheOwner = db;
  installStatementInvalidation(owner);
  return registerListener((owner[disposeCallbacksSymbol] ??= new Set()), callback);
}

export function disposeNodeSqliteDependents(
  owner: StatementCacheOwner,
  reason: SqliteDisposeReason = "close",
): void {
  for (const callback of owner[disposeCallbacksSymbol] ?? []) {
    callback(reason);
  }
}

/** Register the lifecycle owner's handler for synchronous Kysely query failures. */
export function registerNodeSqliteKyselyQueryErrorHandler(
  db: DatabaseSync,
  handler: (error: unknown) => void,
): void {
  queryErrorHandlerByDatabase.set(db, handler);
}

/** Drop cached Kysely state for a DatabaseSync. */
export function clearNodeSqliteKyselyCacheForDatabase(db: DatabaseSync): void {
  // Delete the database-owned cache before close so statements release their
  // native database backreferences instead of recreating the WeakMap leak.
  clearStatementCache(db);
  kyselyByDatabase.delete(db);
  queryErrorHandlerByDatabase.delete(db);
}

export function installStatementInvalidation(owner: StatementCacheOwner): void {
  if (owner[statementInvalidationSymbol]) {
    return;
  }
  if (typeof owner.setAuthorizer === "function") {
    const setAuthorizer = owner.setAuthorizer.bind(owner);
    Object.defineProperty(owner, "setAuthorizer", {
      configurable: true,
      writable: true,
      value(this: StatementCacheOwner, callback: SqliteAuthorizer): void {
        setAuthorizer(callback);
        this[authorizerActiveSymbol] = callback !== null;
        // Authorization is decided while compiling SQL. Drop all statements
        // after every successful transition, including removing an authorizer.
        clearStatementCache(this);
      },
    });
  }
  if (typeof owner.deserialize === "function") {
    const deserialize = owner.deserialize.bind(owner);
    Object.defineProperty(owner, "deserialize", {
      configurable: true,
      writable: true,
      value(this: StatementCacheOwner, ...args: Parameters<DatabaseSync["deserialize"]>): void {
        disposeNodeSqliteDependents(this, "replace");
        try {
          deserialize(...args);
        } finally {
          // Node finalizes all statements before attempting deserialization,
          // including failed attempts, so no cached object remains usable.
          clearStatementCache(this);
        }
      },
    });
  }
  for (const method of ["close", Symbol.dispose] as const) {
    if (typeof owner[method] === "function") {
      const dispose = owner[method].bind(owner);
      Object.defineProperty(owner, method, {
        configurable: true,
        writable: true,
        value(this: StatementCacheOwner): void {
          disposeNodeSqliteDependents(this);
          clearNodeSqliteKyselyCacheForDatabase(this);
          return dispose();
        },
      });
    }
  }
  Object.defineProperty(owner, statementInvalidationSymbol, {
    configurable: true,
    value: true,
  });
}

/**
 * Enable bounded statement caching for a lifecycle-owned database that has not
 * installed an authorizer before this call.
 */
export function enableNodeSqliteKyselyStatementCache(db: DatabaseSync): void {
  const owner: StatementCacheOwner = db;
  installStatementInvalidation(owner);
  owner[statementCacheEnabledSymbol] = true;
}

function queryFitsStatementCache(sql: string, parameters: readonly SQLInputValue[]): boolean {
  let bytes = Buffer.byteLength(sql);
  if (bytes > statementCacheEntryBytes) {
    return false;
  }
  for (const parameter of parameters) {
    if (typeof parameter === "string") {
      // UTF-8 is never shorter than UTF-16 code units; skip an already oversized value.
      if (parameter.length > statementCacheEntryBytes - bytes) {
        return false;
      }
      bytes += Buffer.byteLength(parameter);
    } else if (ArrayBuffer.isView(parameter)) {
      bytes += parameter.byteLength;
    }
    if (bytes > statementCacheEntryBytes) {
      return false;
    }
  }
  return true;
}

// The callback consumes the statement synchronously. A terminal writer can stage
// the same active lease's release with its settlement owner before execution.
// Only the existing database owner enables retention.
export function executeWithCachedStatement<Result>(
  db: EngineConnection,
  sql: string,
  parameters: readonly SQLInputValue[],
  execute: (statement: SqlStatement) => Result,
  scheduleRelease?: (release: () => void) => void,
): Result {
  if (isPostgresSqlConnection(db)) {
    return execute(db.prepare(sql));
  }
  const owner: StatementCacheOwner = db;
  const executeLeased = (statement: StatementSync, release: () => void): Result => {
    if (scheduleRelease) {
      try {
        scheduleRelease(release);
      } catch (error) {
        release();
        throw error;
      }
      return execute(statement);
    }
    try {
      return execute(statement);
    } finally {
      release();
    }
  };
  if (
    !owner[statementCacheEnabledSymbol] ||
    owner[authorizerActiveSymbol] ||
    !queryFitsStatementCache(sql, parameters)
  ) {
    const statement = db.prepare(sql);
    return executeLeased(statement, () => disposeSqliteStatement(statement));
  }
  let cache = owner[statementCacheSymbol];
  if (!cache) {
    cache = {
      statements: new Map(),
      candidates: new Set(),
      active: new WeakSet(),
    };
    Object.defineProperty(owner, statementCacheSymbol, {
      configurable: true,
      value: cache,
    });
  }

  const cached = cache.statements.get(sql);
  let statement: StatementSync;
  if (cached && !cache.active.has(cached)) {
    cache.statements.delete(sql);
    cache.statements.set(sql, cached);
    statement = cached;
  } else {
    // A user-defined SQLite callback can re-enter this helper synchronously.
    // Prepare a temporary statement rather than reset the active outer query.
    statement = db.prepare(sql);
    if (!cached && cache.candidates.delete(sql)) {
      cache.statements.set(sql, statement);
      if (cache.statements.size > statementCacheCapacity) {
        const oldest = cache.statements.entries().next().value!;
        cache.statements.delete(oldest[0]);
        if (!cache.active.has(oldest[1])) {
          disposeSqliteStatement(oldest[1]);
        }
      }
    } else if (!cached) {
      // Admit only on second use so variable placeholder counts cannot fill
      // the native statement cache with one-shot SQL strings.
      cache.candidates.add(sql);
      if (cache.candidates.size > statementCacheCapacity) {
        const oldestCandidate = cache.candidates.values().next().value;
        if (oldestCandidate !== undefined) {
          cache.candidates.delete(oldestCandidate);
        }
      }
    }
  }

  cache.active.add(statement);
  return executeLeased(statement, () => {
    cache.active.delete(statement);
    // Reentrant queries may evict or invalidate an active outer statement.
    if (owner[statementCacheSymbol] !== cache || cache.statements.get(sql) !== statement) {
      disposeSqliteStatement(statement);
    }
  });
}

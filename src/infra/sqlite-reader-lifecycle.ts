import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { normalizeWindowsPathForComparison } from "@openclaw/fs-safe/path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SqliteReaderOwner = {
  operation: string;
  ownerKind: "main" | "worker";
  actorId?: number;
};

export type SqliteReaderDiagnostic = SqliteReaderOwner & {
  kind: "iterator";
  connectionId: number;
  threadId: number;
  ageMs: number;
  idleMs: number;
};

type ActiveReader = Omit<SqliteReaderDiagnostic, "ageMs" | "idleMs"> & {
  startedAtMs: number;
  lastProgressAtMs: number;
};

type ReaderLease = { progress(): void; release(): void };
type Connection = {
  id: number;
  path?: string;
  database: WeakRef<DatabaseSync>;
  owner: SqliteReaderOwner;
  openedAtMs: number;
};

export type SqliteReaderDiagnostics = {
  scope: "current-thread";
  blockingOwner: "unknown";
  nativeStatements: "unobserved";
  threadId: number;
  observedAtMs: number;
  connectionCount: number;
  readerCount: number;
  connections: Array<
    SqliteReaderOwner & {
      connectionId: number;
      threadId: number;
      ageMs: number;
      transactionOpen: boolean;
      trackedReaders: number;
    }
  >;
  activeReaders: SqliteReaderDiagnostic[];
};

const readerOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteReaderOwners"),
  () => new AsyncLocalStorage<SqliteReaderOwner>(),
);

const activeReaders = resolveGlobalSingleton(Symbol.for("openclaw.sqliteActiveReaders"), () => ({
  byDatabase: new WeakMap<DatabaseSync, Map<symbol, ActiveReader>>(),
  byPath: new Map<string, Map<symbol, ActiveReader>>(),
}));

const connections = resolveGlobalSingleton(Symbol.for("openclaw.sqliteReaderConnections"), () => ({
  nextId: 0,
  byDatabase: new WeakMap<DatabaseSync, Connection>(),
  byPath: new Map<string, Map<number, Connection>>(),
  finalizer: new FinalizationRegistry<Connection>((connection) => forgetConnection(connection)),
}));

/** The same Windows file can arrive with a namespaced or differently cased path. */
export function sqliteReaderDatabasePathKey(databasePath: string): string {
  const resolved = path.resolve(databasePath);
  return process.platform === "win32" ? normalizeWindowsPathForComparison(resolved) : resolved;
}

function boundedOperation(operation: string): string {
  const normalized = operation.trim();
  return (normalized || "sqlite reader").slice(0, 120);
}

export function withSqliteReaderOwner<T>(owner: SqliteReaderOwner, operation: () => T): T {
  return readerOwners.run({ ...owner, operation: boundedOperation(owner.operation) }, operation);
}

export function captureSqliteReaderOwner(): SqliteReaderOwner | undefined {
  const owner = readerOwners.getStore();
  return owner ? { ...owner } : undefined;
}

function currentOwner(
  fallbackOperation: string,
  capturedOwner?: SqliteReaderOwner,
): SqliteReaderOwner {
  const inherited = capturedOwner ?? readerOwners.getStore();
  return {
    operation: boundedOperation(inherited?.operation ?? fallbackOperation),
    ownerKind: inherited?.ownerKind ?? (isMainThread ? "main" : "worker"),
    ...(inherited?.actorId !== undefined ? { actorId: inherited.actorId } : {}),
  };
}

function connectionFor(database: DatabaseSync): Connection {
  let connection = connections.byDatabase.get(database);
  if (!connection) {
    const now = Date.now();
    const location = database.location();
    connection = {
      id: ++connections.nextId,
      path: location ? sqliteReaderDatabasePathKey(location) : undefined,
      database: new WeakRef(database),
      owner: currentOwner("sqlite connection"),
      openedAtMs: now,
    };
    connections.byDatabase.set(database, connection);
    if (connection.path) {
      const entries = connections.byPath.get(connection.path) ?? new Map();
      entries.set(connection.id, connection);
      connections.byPath.set(connection.path, entries);
    }
    connections.finalizer.register(database, connection, connection);
  }
  return connection;
}

/** Forget observations only; explicit reader custody belongs to its caller. */
function forgetConnection(connection: Connection): void {
  if (connection.path) {
    const entries = connections.byPath.get(connection.path);
    entries?.delete(connection.id);
    if (entries?.size === 0) {
      connections.byPath.delete(connection.path);
    }
  }
  const database = connection.database.deref();
  if (database && connections.byDatabase.get(database) === connection) {
    connections.byDatabase.delete(database);
  }
  connections.finalizer.unregister(connection);
}

/** Register weak metadata without replacing native methods or acquiring lifecycle custody. */
export function registerSqliteReaderConnection(database: DatabaseSync): void {
  if (database.isOpen) {
    connectionFor(database);
  }
}

export function retainSqliteReader(
  database: DatabaseSync,
  fallbackOperation: string,
  capturedOwner?: SqliteReaderOwner,
): ReaderLease {
  const connection = connectionFor(database);
  const now = Date.now();
  const reader: ActiveReader = {
    ...currentOwner(fallbackOperation, capturedOwner),
    kind: "iterator",
    connectionId: connection.id,
    threadId,
    startedAtMs: now,
    lastProgressAtMs: now,
  };
  const token = Symbol(reader.operation);
  const databaseReaders = activeReaders.byDatabase.get(database) ?? new Map();
  databaseReaders.set(token, reader);
  activeReaders.byDatabase.set(database, databaseReaders);
  const databasePath = connection.path;
  const pathReaders = databasePath
    ? (activeReaders.byPath.get(databasePath) ?? new Map<symbol, ActiveReader>())
    : undefined;
  pathReaders?.set(token, reader);
  if (databasePath && pathReaders) {
    activeReaders.byPath.set(databasePath, pathReaders);
  }
  let released = false;
  return {
    progress() {
      if (!released) {
        reader.lastProgressAtMs = Date.now();
      }
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      databaseReaders.delete(token);
      if (databaseReaders.size === 0) {
        if (activeReaders.byDatabase.get(database) === databaseReaders) {
          activeReaders.byDatabase.delete(database);
        }
      }
      pathReaders?.delete(token);
      if (
        databasePath &&
        pathReaders?.size === 0 &&
        activeReaders.byPath.get(databasePath) === pathReaders
      ) {
        activeReaders.byPath.delete(databasePath);
      }
    },
  };
}

function diagnostics(readers: Iterable<ActiveReader>): SqliteReaderDiagnostic[] {
  const now = Date.now();
  return [...readers]
    .map((reader) => {
      const diagnostic: SqliteReaderDiagnostic = {
        operation: reader.operation,
        ownerKind: reader.ownerKind,
        kind: reader.kind,
        connectionId: reader.connectionId,
        threadId: reader.threadId,
        ageMs: Math.max(0, now - reader.startedAtMs),
        idleMs: Math.max(0, now - reader.lastProgressAtMs),
      };
      if (reader.actorId !== undefined) {
        diagnostic.actorId = reader.actorId;
      }
      return diagnostic;
    })
    .toSorted((left, right) => right.ageMs - left.ageMs)
    .slice(0, 8);
}

function readActiveSqliteReaders(database: DatabaseSync): SqliteReaderDiagnostic[] {
  return diagnostics(activeReaders.byDatabase.get(database)?.values() ?? []);
}

/** Observed local activity is diagnostic evidence, not proof of which connection owns a WAL lock. */
export function readSqliteReaderDiagnosticsForPath(databasePath: string): SqliteReaderDiagnostics {
  const key = sqliteReaderDatabasePathKey(databasePath);
  const entries = connections.byPath.get(key);
  const localConnections: SqliteReaderDiagnostics["connections"] = [];
  const now = Date.now();
  for (const connection of entries?.values() ?? []) {
    const database = connection.database.deref();
    if (!database?.isOpen) {
      forgetConnection(connection);
      continue;
    }
    const location = database.location();
    if (!location || sqliteReaderDatabasePathKey(location) !== key) {
      forgetConnection(connection);
      continue;
    }
    const readers = activeReaders.byDatabase.get(database);
    localConnections.push({
      ...connection.owner,
      connectionId: connection.id,
      threadId,
      ageMs: Math.max(0, now - connection.openedAtMs),
      transactionOpen: database.isTransaction,
      trackedReaders: readers?.size ?? 0,
    });
  }
  const readers = activeReaders.byPath.get(key);
  return {
    scope: "current-thread",
    blockingOwner: "unknown",
    nativeStatements: "unobserved",
    threadId,
    observedAtMs: now,
    connectionCount: localConnections.length,
    readerCount: readers?.size ?? 0,
    connections: localConnections
      .toSorted(
        (left, right) =>
          right.trackedReaders - left.trackedReaders ||
          Number(right.transactionOpen) - Number(left.transactionOpen),
      )
      .slice(0, 8),
    activeReaders: diagnostics(readers?.values() ?? []),
  };
}

export function assertNoActiveSqliteReaders(database: DatabaseSync, label: string): void {
  const readers = readActiveSqliteReaders(database);
  if (readers.length === 0) {
    return;
  }
  const oldest = readers[0]!;
  throw new Error(
    `${label} retained ${readers.length} active SQLite reader(s); oldest operation=${oldest.operation} ageMs=${oldest.ageMs}`,
  );
}

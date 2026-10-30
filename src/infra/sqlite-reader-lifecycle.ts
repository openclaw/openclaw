import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { normalizeWindowsPathForComparison } from "@openclaw/fs-safe/path";
import { AsyncContext } from "../shared/async-context.js";
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
  readers: Map<symbol, ActiveReader>;
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

const readerOwners = new AsyncContext<
  SqliteReaderOwner & {
    timing: {
      preparedAtMs: number;
      hostAdmissionWaitMs: number;
      databaseAdmissionWaitMs: number;
      transactions: { count: number };
    };
  }
>(Symbol.for("openclaw.sqliteReaderOwners"));

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
  return readerOwners.run(
    {
      ...owner,
      operation: boundedOperation(owner.operation),
      timing: {
        preparedAtMs: Date.now(),
        hostAdmissionWaitMs: 0,
        databaseAdmissionWaitMs: 0,
        transactions: readerOwners.getStore()?.timing.transactions ?? { count: 0 },
      },
    },
    operation,
  );
}

export function captureSqliteReaderOwner(): SqliteReaderOwner | undefined {
  const owner = readerOwners.getStore();
  if (!owner) {
    return undefined;
  }
  const { timing: _, ...identity } = owner;
  return identity;
}

/** Mutable diagnostic counters only; never source or write authority. */
export function currentSqliteOperationTiming() {
  return readerOwners.getStore()?.timing;
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
      readers: new Map(),
    };
    connections.byDatabase.set(database, connection);
    connections.finalizer.register(database, connection, connection);
  }
  if (connection.path) {
    const entries = connections.byPath.get(connection.path) ?? new Map();
    entries.set(connection.id, connection);
    connections.byPath.set(connection.path, entries);
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
  // Keep the weak database association so explicit reader assertions survive close.
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
  const databaseReaders = connection.readers;
  databaseReaders.set(token, reader);
  return {
    progress() {
      if (databaseReaders.has(token)) {
        reader.lastProgressAtMs = Date.now();
      }
    },
    release() {
      databaseReaders.delete(token);
    },
  };
}

function diagnostics(readers: Iterable<ActiveReader>): SqliteReaderDiagnostic[] {
  const now = Date.now();
  return [...readers]
    .map(({ startedAtMs, lastProgressAtMs, ...reader }) =>
      Object.assign(reader, {
        ageMs: Math.max(0, now - startedAtMs),
        idleMs: Math.max(0, now - lastProgressAtMs),
      }),
    )
    .toSorted((left, right) => right.ageMs - left.ageMs)
    .slice(0, 8);
}

/** Observed local activity is diagnostic evidence, not proof of which connection owns a WAL lock. */
export function readSqliteReaderDiagnosticsForPath(databasePath: string): SqliteReaderDiagnostics {
  const key = sqliteReaderDatabasePathKey(databasePath);
  const entries = connections.byPath.get(key);
  const localConnections: SqliteReaderDiagnostics["connections"] = [];
  const readers: ActiveReader[] = [];
  const now = Date.now();
  for (const connection of entries?.values() ?? []) {
    const database = connection.database.deref();
    if (!database?.isOpen) {
      forgetConnection(connection);
      continue;
    }
    readers.push(...connection.readers.values());
    localConnections.push({
      ...connection.owner,
      connectionId: connection.id,
      threadId,
      ageMs: Math.max(0, now - connection.openedAtMs),
      transactionOpen: database.isTransaction,
      trackedReaders: connection.readers.size,
    });
  }
  return {
    scope: "current-thread",
    blockingOwner: "unknown",
    nativeStatements: "unobserved",
    threadId,
    observedAtMs: now,
    connectionCount: localConnections.length,
    readerCount: readers.length,
    connections: localConnections
      .toSorted(
        (left, right) =>
          right.trackedReaders - left.trackedReaders ||
          Number(right.transactionOpen) - Number(left.transactionOpen),
      )
      .slice(0, 8),
    activeReaders: diagnostics(readers),
  };
}

export function assertNoActiveSqliteReaders(database: DatabaseSync, label: string): void {
  const readers = diagnostics(connections.byDatabase.get(database)?.readers.values() ?? []);
  if (readers.length === 0) {
    return;
  }
  const oldest = readers[0]!;
  throw new Error(
    `${label} retained ${readers.length} active SQLite reader(s); oldest operation=${oldest.operation} ageMs=${oldest.ageMs}`,
  );
}

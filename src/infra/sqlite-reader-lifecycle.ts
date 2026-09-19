import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SqliteReaderOwner = {
  operation: string;
  ownerKind: "main" | "worker";
  actorId?: number;
};

export type SqliteReaderDiagnostic = SqliteReaderOwner & {
  ageMs: number;
  idleMs: number;
};

type ActiveReader = SqliteReaderOwner & {
  startedAtMs: number;
  lastProgressAtMs: number;
};

const readerOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteReaderOwners"),
  () => new AsyncLocalStorage<SqliteReaderOwner>(),
);

const activeReaders = resolveGlobalSingleton(Symbol.for("openclaw.sqliteActiveReaders"), () => ({
  byDatabase: new WeakMap<DatabaseSync, Map<symbol, ActiveReader>>(),
  byPath: new Map<string, Map<symbol, ActiveReader>>(),
}));

function normalizedDatabasePath(database: DatabaseSync): string | undefined {
  const location = database.location();
  return location ? path.resolve(location) : undefined;
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

export function retainSqliteReader(
  database: DatabaseSync,
  fallbackOperation: string,
  capturedOwner?: SqliteReaderOwner,
): { progress(): void; release(): void } {
  const inherited = capturedOwner ?? readerOwners.getStore();
  const now = Date.now();
  const reader: ActiveReader = {
    operation: boundedOperation(inherited?.operation ?? fallbackOperation),
    ownerKind: inherited?.ownerKind ?? "main",
    ...(inherited?.actorId !== undefined ? { actorId: inherited.actorId } : {}),
    startedAtMs: now,
    lastProgressAtMs: now,
  };
  const token = Symbol(reader.operation);
  const databaseReaders = activeReaders.byDatabase.get(database) ?? new Map();
  databaseReaders.set(token, reader);
  activeReaders.byDatabase.set(database, databaseReaders);
  const databasePath = normalizedDatabasePath(database);
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
        activeReaders.byDatabase.delete(database);
      }
      pathReaders?.delete(token);
      if (databasePath && pathReaders?.size === 0) {
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

export function readActiveSqliteReadersForPath(databasePath: string): SqliteReaderDiagnostic[] {
  return diagnostics(activeReaders.byPath.get(path.resolve(databasePath))?.values() ?? []);
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

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

// Handles can cross transformed SDK module graphs. Retain their first terminal
// failure even when an inner caller catches it and continues.
const abortedTransactionSymbol = Symbol.for("openclaw.sqliteAbortedTransaction");

export function assertPostgresTransactionUsable(
  db: PostgresSqlConnection & { [abortedTransactionSymbol]?: { error: unknown } },
): void {
  const aborted = db[abortedTransactionSymbol];
  if (aborted) {
    throw aborted.error;
  }
}

export function assertSyncTransactionResult(value: unknown): void {
  if (isPromiseLike(value)) {
    throw new Error(
      "SQLite write transactions must be synchronous; Promise returns are not supported.",
    );
  }
}

export interface SqlStatement {
  get(...parameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
  all(...parameters: SQLInputValue[]): Record<string, SQLOutputValue>[];
  iterate(...parameters: SQLInputValue[]): IterableIterator<Record<string, SQLOutputValue>>;
  run(...parameters: SQLInputValue[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  columns(): { name: string }[];
  setReadBigInts(enabled: boolean): void;
}

export interface SqlConnection {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
}

const postgresConnectionBrand = Symbol.for("openclaw.postgres-sync-connection");

export interface PostgresSqlConnection extends SqlConnection {
  readonly anchor: DatabaseSync;
  readonly mutationRevision: number;
  readonly advisoryLockKey: bigint;
  query: (
    sql: string,
    parameters?: readonly SQLInputValue[],
  ) => {
    rows: Record<string, SQLOutputValue>[];
    rowCount: number;
    columns: { name: string }[];
  };
  runTransaction<T>(
    operation: () => T,
    options?: { withCommit?: (commit: () => void) => void },
    ...modes: [readOnly?: boolean, reserved?: boolean]
  ): T;
}

export type EngineConnection = DatabaseSync | PostgresSqlConnection;

export function isPostgresSqlConnection(db: object): db is PostgresSqlConnection {
  return postgresConnectionBrand in db && db[postgresConnectionBrand] === true;
}

/** Publications and receipts must key on the store anchor for every engine. */
export function sqlPublicationAnchor(db: DatabaseSync | PostgresSqlConnection): DatabaseSync {
  return isPostgresSqlConnection(db) ? db.anchor : db;
}

import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

// Handles can cross transformed SDK module graphs. Retain their first terminal
// failure even when an inner caller catches it and continues.
const abortedTransactionSymbol = Symbol.for("openclaw.sqliteAbortedTransaction");

export function assertTransactionUsable(
  db: SqlConnection & { [abortedTransactionSymbol]?: { error: unknown } },
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

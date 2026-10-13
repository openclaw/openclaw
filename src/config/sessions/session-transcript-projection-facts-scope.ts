import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { readSqliteDatabaseScopedWriteToken } from "../../infra/sqlite-database-admission.js";
import { hasUncommittedSqliteWrites } from "../../infra/sqlite-schema-facts.js";
import type { SessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts.types.js";

const projectionReceipts = new AsyncLocalStorage<SessionTranscriptProjectionReceipt | undefined>();

/** A worker task opens its own snapshots; no fact survives into another task. */
export function withSessionTranscriptProjectionReceipt<T>(
  receipt: SessionTranscriptProjectionReceipt | undefined,
  read: () => T,
): T {
  return projectionReceipts.run(receipt, read);
}

export function readSessionTranscriptProjectionReceipt(
  database: { db: DatabaseSync; path: string },
  sessionId: string,
) {
  const receipt = projectionReceipts.getStore();
  if (
    !receipt ||
    receipt.path !== database.path ||
    receipt.sessionId !== sessionId ||
    hasUncommittedSqliteWrites(database.db) ||
    readSqliteDatabaseScopedWriteToken(database.db, receipt.writeScopes) !== receipt.writeToken
  ) {
    return undefined;
  }
  return structuredClone(receipt.facts);
}

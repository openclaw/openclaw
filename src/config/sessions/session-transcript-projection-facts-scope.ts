import { AsyncLocalStorage } from "node:async_hooks";
import type { EngineConnection } from "../../infra/sql-connection.js";
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

/** Worker transport already isolated these facts; readers borrow them within this task. */
export function readSessionTranscriptProjectionReceipt(
  database: { db: EngineConnection; path: string },
  sessionId: string,
) {
  const receipt = projectionReceipts.getStore();
  if (
    !receipt ||
    receipt.sessionId !== sessionId ||
    hasUncommittedSqliteWrites(database.db) ||
    // The scoped token binds the admitted physical store and its committed revision.
    readSqliteDatabaseScopedWriteToken(database.db, receipt.writeScopes) !== receipt.writeToken
  ) {
    return undefined;
  }
  return receipt;
}

/** Accounting needs row validity, already established by the complete actor postimage. */
export function hasSessionTranscriptEntryReceipt(
  database: { db: EngineConnection; path: string },
  sessionId: string,
  sessionKey: string,
): boolean {
  return (
    readSessionTranscriptProjectionReceipt(database, sessionId)?.entrySessionKey === sessionKey
  );
}

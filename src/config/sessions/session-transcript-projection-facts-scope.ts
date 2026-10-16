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

function readCurrentReceipt(database: { db: EngineConnection; path: string }, sessionId: string) {
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
  return receipt;
}

export function readSessionTranscriptProjectionReceipt(
  database: { db: EngineConnection; path: string },
  sessionId: string,
) {
  const receipt = readCurrentReceipt(database, sessionId);
  return receipt && structuredClone({ facts: receipt.facts, contextOnly: receipt.contextOnly });
}

/** Accounting needs row validity, already established by the complete actor postimage. */
export function hasSessionTranscriptEntryReceipt(
  database: { db: EngineConnection; path: string },
  sessionId: string,
  sessionKey: string,
): boolean {
  return readCurrentReceipt(database, sessionId)?.entrySessionKey === sessionKey;
}

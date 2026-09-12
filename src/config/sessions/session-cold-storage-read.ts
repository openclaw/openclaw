import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  assertSessionTranscriptHot,
  SessionTranscriptColdError,
} from "./session-cold-storage-state.js";

/** The cold marker and hot rows must belong to one snapshot, including cached statement lookups. */
export function readHotSessionTranscriptSnapshot<T>(
  database: { db: DatabaseSync },
  sessionId: string,
  read: () => T,
): T {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, sessionId);
      return read();
    },
    { operationLabel: "session transcript hot read" },
  );
}

/** A peer can archive after restoration settles but before the synchronous read starts. */
export async function readRestoredSessionTranscript<T>(
  scope: SessionTranscriptReadScope,
  read: () => T,
): Promise<T> {
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  await restoreSessionColdTranscript(scope);
  try {
    return read();
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== scope.sessionId) {
      throw error;
    }
    await restoreSessionColdTranscript(scope);
    return read();
  }
}

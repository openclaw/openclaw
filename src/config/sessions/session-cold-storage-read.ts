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
  purpose:
    | "identity"
    | "header"
    | "tail"
    | "incremental"
    | "checkpoint"
    | "events"
    | "raw rows"
    | "storage rows"
    | "match",
  read: () => T,
): T {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, sessionId);
      return read();
    },
    { operationLabel: `session transcript ${purpose} read` },
  );
}

/** A peer can archive after restoration settles but before the read completes. */
export async function readRestoredSessionTranscript<T>(
  scope: SessionTranscriptReadScope,
  read: () => T | Promise<T>,
  options?: { readOnly?: boolean; assertCurrent?: () => void },
): Promise<T> {
  options?.assertCurrent?.();
  // Read workers report cold storage to their host; only the host restores it.
  if (options?.readOnly) {
    return read();
  }
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  await restoreSessionColdTranscript(scope, options?.assertCurrent);
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== scope.sessionId) {
      throw error;
    }
    await restoreSessionColdTranscript(scope, options?.assertCurrent);
    return await read();
  }
}

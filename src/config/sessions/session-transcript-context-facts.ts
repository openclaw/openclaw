import type { DatabaseSync } from "node:sqlite";
import {
  getSqliteReadScopeRevision,
  type SqliteReadScopeRevision,
} from "../../infra/sqlite-schema-facts.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";

type TranscriptDatabase = { db: DatabaseSync };

// Only the current transaction's last transcript is retained. Native writes and
// rollback retire its revision; committed facts never become a turn-long cache.
const contextFacts = new WeakMap<
  DatabaseSync,
  {
    sessionId: string;
    revision: SqliteReadScopeRevision;
    version: SessionTranscriptContextVersion;
    cold?: boolean;
  }
>();

export function readTranscriptContextFacts(database: TranscriptDatabase, sessionId: string) {
  const revision = database.db.isTransaction ? getSqliteReadScopeRevision(database.db) : undefined;
  const retained = contextFacts.get(database.db);
  return revision && retained?.revision === revision && retained.sessionId === sessionId
    ? retained
    : undefined;
}

export function retainTranscriptContextFacts(
  database: TranscriptDatabase,
  sessionId: string,
  version: SessionTranscriptContextVersion,
  revision: SqliteReadScopeRevision | undefined,
  cold?: boolean,
) {
  if (database.db.isTransaction && revision) {
    contextFacts.set(database.db, { sessionId, revision, version: { ...version }, cold });
  }
}

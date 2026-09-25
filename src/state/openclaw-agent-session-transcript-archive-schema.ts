import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_TRANSCRIPT_ARCHIVES_TABLE = "session_transcript_archives";

const ENSURED_DATABASES = new WeakSet<DatabaseSync>();

/** Lazily installs the additive canonical archive owner on first archive use. */
export function ensureSessionTranscriptArchiveSchema(db: DatabaseSync): void {
  if (ENSURED_DATABASES.has(db)) {
    return;
  }
  const ensure = () => {
    // sqlite-allow-raw -- Canonical additive DDL only.
    db.exec(
      extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_TRANSCRIPT_ARCHIVES_TABLE, {
        endMarker: "CREATE TABLE IF NOT EXISTS transcript_rewrite_watermarks (",
        includeEndMarker: false,
        errorMessage: "OpenClaw session transcript archive schema markers are missing.",
      }),
    );
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
  ENSURED_DATABASES.add(db);
}

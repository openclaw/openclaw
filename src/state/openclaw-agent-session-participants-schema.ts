import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_PARTICIPANTS_TABLE = "session_participants";

const ensuredDatabases = new WeakSet<DatabaseSync>();

export function sessionParticipantsSchemaSql(): string {
  return extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_PARTICIPANTS_TABLE, {
    endMarker: "CREATE TABLE IF NOT EXISTS session_key_contract (",
    includeEndMarker: false,
    errorMessage: "OpenClaw session participant schema markers are missing.",
  });
}

/** Lazily installs the additive participant table on the first admitted prompt. */
export function ensureSessionParticipantsSchema(database: DatabaseSync): boolean {
  if (ensuredDatabases.has(database)) {
    return false;
  }
  const ensure = () => {
    // sqlite-allow-raw -- canonical additive DDL only.
    database.exec(sessionParticipantsSchemaSql());
  };
  if (database.isTransaction) {
    ensure();
    return true;
  }
  runSqliteImmediateTransactionSync(database, ensure);
  ensuredDatabases.add(database);
  return false;
}

/** Cache a first-use ensure only after its owning transaction commits. */
export function confirmSessionParticipantsSchemaEnsured(database: DatabaseSync): void {
  ensuredDatabases.add(database);
}

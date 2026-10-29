import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import {
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
  PROGRESS_CARD_WORK_COLUMNS,
  SESSION_PROGRESS_CARDS_TABLE,
} from "./openclaw-agent-schema-history.js";
import { tableExists, readTableColumns } from "./openclaw-state-db-schema-helpers.js";

export {
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
  PROGRESS_CARD_WORK_COLUMNS,
  SESSION_PROGRESS_CARDS_TABLE,
} from "./openclaw-agent-schema-history.js";

const postgresProgressTable = /CREATE TABLE "session_progress_cards" \([\s\S]*?\n\);/u;

/** Historical catalogs must not acquire columns before their versioned migration. */
export function withoutAgentPostgresProgressWork(schema: string): string {
  return schema.replace(postgresProgressTable, (table) =>
    table
      .split("\n")
      .filter(
        (line) =>
          !PROGRESS_CARD_WORK_COLUMNS.some(([column]) => line.startsWith('  "' + column + '" ')),
      )
      .join("\n"),
  );
}

export function agentProgressWorkPostgresMigration(schema: string): string {
  return (schema.match(postgresProgressTable)?.[0] ?? "")
    .split("\n")
    .filter((line) =>
      PROGRESS_CARD_WORK_COLUMNS.some(([column]) => line.startsWith('  "' + column + '" ')),
    )
    .map(
      (line) =>
        'ALTER TABLE "session_progress_cards" ADD COLUMN ' + line.trim().replace(/,$/u, "") + ";",
    )
    .join("\n");
}

/** Ensure the additive progress-card table inside the caller's write transaction. */
export function ensureOpenClawAgentProgressCardSchemaInTransaction(db: EngineConnection): void {
  if (!db.isTransaction) {
    throw new Error("progress-card schema ensure requires an active transaction");
  }
  if (isPostgresSqlConnection(db)) {
    return;
  }
  if (!tableExists(db, SESSION_PROGRESS_CARDS_TABLE)) {
    db.exec(AGENT_PROGRESS_CARD_SCHEMA_SQL); // sqlite-allow-raw -- Canonical lazy-table bootstrap.
    return;
  }
  const columns = readTableColumns(db, SESSION_PROGRESS_CARDS_TABLE);
  // Existing cards stay display-only. Partial upgrades resume under the same write admission.
  for (const [column, declaration] of PROGRESS_CARD_WORK_COLUMNS) {
    if (!columns.has(column)) {
      db.exec("ALTER TABLE session_progress_cards ADD COLUMN " + column + " " + declaration); // sqlite-allow-raw -- Fixed additive schema declarations owned here.
    }
  }
}

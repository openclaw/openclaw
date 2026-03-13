/**
 * Doctor check: SQLite state database health.
 *
 * Reports operator1.db existence, integrity, schema version, size, and key table row counts.
 */
import fs from "node:fs";
import { getStateDbPath } from "../infra/state-db/connection.js";
import {
  checkStateDbIntegrity,
  getSchemaVersion,
  getStateDb,
  getTableRowCount,
  listTables,
} from "../infra/state-db/index.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

/** Key tables to report row counts for. */
const KEY_TABLES = [
  "session_entries",
  "delivery_queue",
  "op1_team_registry",
  "op1_auth_profiles",
  "op1_channel_pairing",
  "op1_channel_allowlist",
  "op1_channel_thread_bindings",
  "core_settings",
  "op1_config",
  "op1_mcp_registries",
  "op1_agent_registries",
  "op1_agent_locks",
  "op1_projects",
  "op1_telegram_topic_bindings",
];

export function noteStateDbHealth(): void {
  const dbPath = getStateDbPath();
  const displayPath = shortenHomePath(dbPath);

  if (!fs.existsSync(dbPath)) {
    note(
      `- State database not found at ${displayPath}. It will be created on next gateway start.`,
      "State DB",
    );
    return;
  }

  const integrity = checkStateDbIntegrity(dbPath);
  if (!integrity.ok) {
    note(
      [
        `- CRITICAL: State database corrupt (${displayPath}).`,
        `  Error: ${integrity.error ?? "unknown"}`,
        "- The corrupt file has been renamed. A fresh database will be created on next gateway start.",
        "- Restore from a prior 'openclaw state export' backup if needed.",
      ].join("\n"),
      "State DB",
    );
    return;
  }

  const lines: string[] = [];

  // DB file size
  try {
    const stat = fs.statSync(dbPath);
    const sizeKb = Math.round(stat.size / 1024);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
    const sizeStr = stat.size >= 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
    lines.push(`- Database: ${displayPath} (${sizeStr})`);
  } catch {
    lines.push(`- Database: ${displayPath}`);
  }

  // Schema version + table counts
  try {
    const db = getStateDb();
    const version = getSchemaVersion(db);
    const tables = listTables(db);
    lines.push(`- Schema version: ${version} (${tables.length} tables)`);

    const counts: string[] = [];
    for (const table of KEY_TABLES) {
      if (tables.includes(table)) {
        const count = getTableRowCount(db, table);
        if (count > 0) {
          counts.push(`${table}: ${count}`);
        }
      }
    }
    if (counts.length > 0) {
      lines.push(`- Row counts: ${counts.join(", ")}`);
    }
  } catch (err) {
    lines.push(`- Schema check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (lines.length > 0) {
    note(lines.join("\n"), "State DB");
  }
}

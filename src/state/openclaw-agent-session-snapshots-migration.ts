import type { DatabaseSync } from "node:sqlite";
import { parseSqliteSessionEntryRecord } from "../config/sessions/session-entry-json.js";
import {
  splitSessionEntrySnapshots,
  type SessionEntrySnapshot,
} from "../config/sessions/session-entry-snapshots.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "./openclaw-agent-db-lease.js";
import type { DB } from "./openclaw-agent-db.generated.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { sessionEntrySnapshotsSchemaSql } from "./openclaw-agent-session-snapshots-schema.js";

/** The existing schema owner holds maintenance authority and the outer write transaction. */
export function migrateSessionEntrySnapshotsInTransaction(database: DatabaseSync): void {
  // sqlite-allow-raw -- Versioned schema DDL precedes the typed data migration.
  database.exec(
    "ALTER TABLE session_nodes ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 0",
  );
  // sqlite-allow-raw -- Install the canonical snapshot table and its revision triggers.
  database.exec(sessionEntrySnapshotsSchemaSql(OPENCLAW_AGENT_SCHEMA_SQL));
  const db = getNodeSqliteKysely<DB>(database);
  const select = db
    .selectFrom("session_nodes")
    .select(["session_key", "current_session_id", "updated_at", "entry_json"])
    .orderBy("session_key")
    .limit(64);
  const selectAfter = prepareSqliteQuerySync<
    string,
    Pick<DB["session_nodes"], "session_key" | "current_session_id" | "updated_at" | "entry_json">
  >(database, (parameter) =>
    select.where(
      "session_key",
      ">",
      parameter((key) => key),
    ),
  );
  const insert = prepareSqliteQuerySync<SessionEntrySnapshot & { sessionKey: string }>(
    database,
    (parameter) =>
      db.insertInto("session_entry_snapshots").values({
        session_key: parameter((row) => row.sessionKey),
        field: parameter((row) => row.field),
        value_json: parameter((row) => row.valueJson),
      }),
  );
  const update = prepareSqliteQuerySync<{ sessionKey: string; entryJson: string }>(
    database,
    (parameter) =>
      db
        .updateTable("session_nodes")
        .set({ entry_json: parameter((row) => row.entryJson) })
        .where(
          "session_key",
          "=",
          parameter((row) => row.sessionKey),
        ),
  );
  const markValid = prepareSqliteQuerySync<string>(database, (parameter) =>
    db
      .updateTable("session_nodes")
      .set({ entry_valid: 1 })
      .where(
        "session_key",
        "=",
        parameter((key) => key),
      ),
  );
  let after: string | undefined;
  while (true) {
    const { rows } =
      after === undefined ? executeSqliteQuerySync(database, select) : selectAfter(after);
    if (rows.length === 0) {
      return;
    }
    renewAgentDatabaseMaintenanceAuthorityIfPresent();
    for (const row of rows) {
      if (
        typeof row.session_key !== "string" ||
        typeof row.current_session_id !== "string" ||
        typeof row.updated_at !== "number" ||
        typeof row.entry_json !== "string"
      ) {
        throw new Error("Unreadable session row during snapshot migration");
      }
      after = row.session_key;
      const entry = parseSqliteSessionEntryRecord({
        current_session_id: row.current_session_id,
        updated_at: row.updated_at,
        entry_json: row.entry_json,
      });
      // Preserve corrupt, identity-mismatched and retained-window rows byte-for-byte for Doctor.
      if (!entry) {
        continue;
      }
      const { entryJson, snapshots } = splitSessionEntrySnapshots(entry);
      if (snapshots.length === 0) {
        continue;
      }
      for (const snapshot of snapshots) {
        insert({ sessionKey: row.session_key, ...snapshot });
      }
      update({ entryJson, sessionKey: row.session_key });
      markValid(row.session_key);
    }
  }
}

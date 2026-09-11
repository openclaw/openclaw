// Removes transient runtime state from restorable OpenClaw database snapshots.
import type { DatabaseSync } from "node:sqlite";
import { tryParsePersistedExecApprovals } from "../infra/exec-approvals-config.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import { projectionValues } from "../infra/exec-approvals-sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { clearOpenClawStateCopyLeases } from "./openclaw-state-copy-leases.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";

type SnapshotSanitizerDatabase = Pick<OpenClawStateKyselyDatabase, "exec_approvals_config">;

const FAIL_CLOSED_EXEC_APPROVALS: ExecApprovalsFile = {
  version: 1,
  defaults: {
    security: "deny",
    ask: "off",
    askFallback: "deny",
    autoAllowSkills: false,
  },
  agents: {},
};

/** Remove transient rows whose restoration would replay work or extend private-data retention. */
export function sanitizeOpenClawGlobalStateSnapshot(database: DatabaseSync): void {
  // Archive backup can encounter an older database shape, so each optional
  // table is detected before applying the current sanitizer contract.
  clearOpenClawStateCopyLeases(database);
  if (tableExists(database, "delivery_queue_entries")) {
    database.prepare("DELETE FROM delivery_queue_entries").run(); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  }
  if (tableExists(database, "plugin_blob_entries")) {
    // A TTL marks blob data as transient. Exclude every TTL row, including one
    // that is still live, so restore cannot prolong its original retention.
    database.prepare("DELETE FROM plugin_blob_entries WHERE expires_at IS NOT NULL").run(); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  }
  if (tableExists(database, "exec_approvals_config")) {
    const stateDb = getNodeSqliteKysely<SnapshotSanitizerDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      stateDb.selectFrom("exec_approvals_config").select(["config_key", "raw_json"]),
    ).rows;
    for (const row of rows) {
      let sanitized: ExecApprovalsFile = FAIL_CLOSED_EXEC_APPROVALS;
      const parsed = tryParsePersistedExecApprovals(row.raw_json);
      if (parsed) {
        sanitized = structuredClone(parsed);
        if (sanitized.socket) {
          delete sanitized.socket.token;
        }
      }
      executeSqliteQuerySync(
        database,
        stateDb
          .updateTable("exec_approvals_config")
          .set({
            raw_json: `${JSON.stringify(sanitized, null, 2)}\n`,
            ...projectionValues(sanitized),
          })
          .where("config_key", "=", row.config_key),
      );
    }
  }
}

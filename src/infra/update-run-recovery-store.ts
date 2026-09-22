import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { UPDATE_RECOVERY_KEY_END, UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import {
  decodeUpdateRecovery,
  inspectUpdateRecovery,
  type UpdateRecoveryInspection,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";

type RecoveryDatabase = Pick<DB, "update_runs" | "config_machine_state">;

/** A descriptor reserves its history for fenced recovery, even when its driver died.
 * Presence is exclusion only: corrupt or older evidence never grants cleanup authority. */
export function hasStoredUpdateRecovery(db: DatabaseSync, runId: string): boolean {
  return (
    tableExists(db, "config_machine_state") &&
    Boolean(
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<RecoveryDatabase>(db)
          .selectFrom("config_machine_state")
          .select("state_key")
          .where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + runId),
      ),
    )
  );
}

function readRecoveryRows(db: DatabaseSync) {
  if (!tableExists(db, "config_machine_state")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<RecoveryDatabase>(db)
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json"])
      .where("state_key", ">=", UPDATE_RECOVERY_KEY_PREFIX)
      .where("state_key", "<", UPDATE_RECOVERY_KEY_END)
      .orderBy("state_key", "asc"),
  ).rows;
}
export function readRecoveries(db: DatabaseSync): UpdateRecoveryRecord[] {
  return readRecoveryRows(db).map((row) =>
    decodeUpdateRecovery(row.value_json, row.state_key.slice(UPDATE_RECOVERY_KEY_PREFIX.length)),
  );
}
function inspectRecoveries(db: DatabaseSync): UpdateRecoveryInspection[] {
  return readRecoveryRows(db).map((row) =>
    inspectUpdateRecovery(row.value_json, row.state_key.slice(UPDATE_RECOVERY_KEY_PREFIX.length)),
  );
}
/** Private read-only compatibility surface for diagnostics and retained-pair
 * inspection. Legacy receipts remain exact historical evidence, never authority.
 * Execution loaders below deliberately reject them instead of upgrading them. */
export function inspectUpdateRecoveries(
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryInspection[] {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => inspectRecoveries(db),
      options,
    ) ?? []
  );
}

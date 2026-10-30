import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { withUpdateRunRead } from "./update-run-admission.js";
import { UPDATE_RECOVERY_KEY_END, UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import {
  decodeUpdateRecovery,
  inspectUpdateRecovery,
  type UpdateRecoveryInspection,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";

type RecoveryDatabase = Pick<DB, "update_runs" | "config_machine_state">;

function readRecoveryRows(db: EngineConnection, runId?: string) {
  if (!tableExists(db, "config_machine_state")) {
    return [];
  }
  const query = getNodeSqliteKysely<RecoveryDatabase>(db)
    .selectFrom("config_machine_state")
    .select(["state_key", "value_json"]);
  return executeSqliteQuerySync(
    db,
    runId === undefined
      ? query
          .where("state_key", ">=", UPDATE_RECOVERY_KEY_PREFIX)
          .where("state_key", "<", UPDATE_RECOVERY_KEY_END)
          .orderBy("state_key", "asc")
      : query.where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + runId),
  ).rows;
}
/** Execution reads only its named operation; unrelated history is not execution input. */
export function readRecovery(
  db: EngineConnection,
  runId: string,
): UpdateRecoveryRecord | undefined {
  const row = readRecoveryRows(db, runId)[0];
  return row ? decodeUpdateRecovery(row.value_json, runId) : undefined;
}

export function inspectRecoveryRows(db: EngineConnection): UpdateRecoveryInspection[] {
  return readRecoveryRows(db).map(({ value_json, state_key }) =>
    inspectUpdateRecovery(value_json, state_key.slice(UPDATE_RECOVERY_KEY_PREFIX.length)),
  );
}
/** Private read-only compatibility surface for diagnostics and retained-pair
 * inspection. Legacy receipts remain exact historical evidence, never authority.
 * Execution loaders below deliberately reject them instead of upgrading them. */
export function inspectUpdateRecoveries(
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryInspection[] {
  return withUpdateRunRead(({ db }) => inspectRecoveryRows(db), options) ?? [];
}

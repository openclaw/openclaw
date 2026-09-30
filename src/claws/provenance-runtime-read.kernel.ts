import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export type ClawInstallSchemaVersionRow = {
  agentId: string;
  schemaVersion: string;
  agentConfigDigest: string;
  agentOwnershipPayloadJson: string;
};

export function readClawInstallSchemaVersionRows(db: DatabaseSync): ClawInstallSchemaVersionRow[] {
  if (!tableExists(db, "claw_installs")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "claw_installs">>(db)
      .selectFrom("claw_installs")
      .select([
        "agent_id as agentId",
        "schema_version as schemaVersion",
        "agent_config_digest as agentConfigDigest",
        "agent_owned_paths_json as agentOwnershipPayloadJson",
      ]),
  ).rows;
}

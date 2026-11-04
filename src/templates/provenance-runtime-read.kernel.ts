import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export type TemplateInstallSchemaVersionRow = {
  agentId: string;
  schemaVersion: string;
  agentConfigDigest: string;
};

export function readTemplateInstallSchemaVersionRows(
  db: EngineConnection,
): TemplateInstallSchemaVersionRow[] {
  if (!tableExists(db, "template_installs")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "template_installs">>(db)
      .selectFrom("template_installs")
      .select([
        "agent_id as agentId",
        "schema_version as schemaVersion",
        "agent_config_digest as agentConfigDigest",
      ]),
  ).rows;
}

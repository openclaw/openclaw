import type { EngineConnection } from "../infra/sql-connection.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

const TEMPLATE_SECONDARY_REFERENCE_TABLES = [
  "template_package_refs",
  "template_mcp_server_refs",
  "template_cron_refs",
] as const;

export function readTemplateSecondaryReferenceTables(
  db: EngineConnection,
  agentId: string,
): string[] {
  return TEMPLATE_SECONDARY_REFERENCE_TABLES.filter((table) => {
    if (!tableExists(db, table)) {
      return false;
    }
    return Boolean(
      db /* sqlite-allow-raw: read-only point check for secondary Template ownership before migration. */
        .prepare(`SELECT 1 FROM ${table} WHERE agent_id = ? LIMIT 1`)
        .get(agentId),
    );
  });
}

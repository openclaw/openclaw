import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

const CLAW_SECONDARY_REFERENCE_TABLES = [
  "claw_package_refs",
  "claw_mcp_server_refs",
  "claw_cron_refs",
] as const;

export function readClawSecondaryReferenceTables(db: DatabaseSync, agentId: string): string[] {
  return CLAW_SECONDARY_REFERENCE_TABLES.filter((table) => {
    if (!tableExists(db, table)) {
      return false;
    }
    return Boolean(
      db /* sqlite-allow-raw: read-only point check for secondary Claw ownership before migration. */
        .prepare(`SELECT 1 FROM ${table} WHERE agent_id = ? LIMIT 1`)
        .get(agentId),
    );
  });
}

import type { DatabaseSync } from "node:sqlite";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export type ExistingAgentSchemaMeta = {
  agentId: string | null;
  role: string | null;
  schemaVersion: number | null;
};

/** Read ownership metadata without loading runtime schema or migration owners. */
export function readExistingAgentSchemaMeta(db: DatabaseSync): ExistingAgentSchemaMeta | null {
  if (!tableExists(db, "schema_meta")) {
    return null;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "schema_meta">>(db)
      .selectFrom("schema_meta")
      .select(["role", "schema_version", "agent_id"])
      .where("meta_key", "=", "primary"),
  );
  if (!row) {
    return null;
  }
  return {
    agentId: normalizeNullableString(row.agent_id),
    role: typeof row.role === "string" ? row.role : null,
    schemaVersion: typeof row.schema_version === "number" ? row.schema_version : null,
  };
}

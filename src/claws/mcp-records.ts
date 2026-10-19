import type { Selectable } from "kysely";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export const CLAW_MCP_REF_SCHEMA_VERSION = "openclaw.clawMcpServerRef.v1" as const;

export type PersistedClawMcpServerRef = {
  schemaVersion: typeof CLAW_MCP_REF_SCHEMA_VERSION;
  agentId: string;
  name: string;
  configDigest: string;
  relationship: "managed" | "referenced";
  origin: "claw-introduced" | "pre-existing";
  independentOwner: boolean;
  status: "pending" | "complete" | "failed";
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type McpDatabase = Pick<DB, "claw_mcp_server_refs">;
type McpRefRow = Selectable<DB["claw_mcp_server_refs"]>;

function selectMcpRefs(db: EngineConnection) {
  return getNodeSqliteKysely<McpDatabase>(db)
    .selectFrom("claw_mcp_server_refs")
    .select([
      "schema_version",
      "agent_id",
      "name",
      "config_digest",
      "relationship",
      "origin",
      "independent_owner",
      "status",
      "error",
      "created_at_ms",
      "updated_at_ms",
    ]);
}

function rowToRef(row: McpRefRow): PersistedClawMcpServerRef {
  return {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    name: row.name,
    configDigest: row.config_digest,
    // SAFETY: The canonical table constrains relationship to these two values.
    relationship: row.relationship as PersistedClawMcpServerRef["relationship"],
    // SAFETY: The canonical table constrains origin to these two values.
    origin: row.origin as PersistedClawMcpServerRef["origin"],
    independentOwner: sqliteNumber(row.independent_owner) === 1,
    // SAFETY: Existing inventory exposes stored status without additional validation.
    status: row.status as PersistedClawMcpServerRef["status"],
    ...(row.error !== null ? { error: row.error } : {}),
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

export function readAllClawMcpServerRefsInDatabase(
  db: EngineConnection,
): PersistedClawMcpServerRef[] {
  if (!tableExists(db, "claw_mcp_server_refs")) {
    return [];
  }
  const query = selectMcpRefs(db).orderBy("agent_id").orderBy("name").compile();
  const rows = db /* sqlite-allow-raw: read-only Claw MCP reference inventory. */
    .prepare(query.sql)
    // SAFETY: the query projects every persisted Claw MCP reference column.
    .all() as McpRefRow[];
  return rows.map(rowToRef);
}

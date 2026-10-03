import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
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

export type McpDatabase = Pick<DB, "claw_mcp_server_refs">;
export type McpRefRow = Selectable<DB["claw_mcp_server_refs"]>;

export function selectMcpRefs(db: DatabaseSync) {
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

export function refToRow(ref: PersistedClawMcpServerRef): McpRefRow {
  return {
    agent_id: ref.agentId,
    name: ref.name,
    schema_version: ref.schemaVersion,
    config_digest: ref.configDigest,
    relationship: ref.relationship,
    origin: ref.origin,
    independent_owner: ref.independentOwner ? 1 : 0,
    status: ref.status,
    error: ref.error ?? null,
    created_at_ms: ref.createdAtMs,
    updated_at_ms: ref.updatedAtMs,
  };
}

export function rowToRef(row: McpRefRow): PersistedClawMcpServerRef {
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
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

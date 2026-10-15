import type { Selectable } from "kysely";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export const CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION =
  "openclaw.clawWorkspaceFileRecord.v1" as const;

export type PersistedClawWorkspaceFile = {
  schemaVersion: typeof CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION;
  agentId: string;
  workspace: string;
  path: string;
  sourcePath: string;
  contentDigest: string;
  status: "pending" | "complete" | "failed";
  createdAtMs: number;
  updatedAtMs: number;
};

export type WorkspaceDatabase = Pick<DB, "claw_workspace_files">;
export type WorkspaceFileRow = Selectable<DB["claw_workspace_files"]>;

function selectWorkspaceFiles(db: EngineConnection) {
  return getNodeSqliteKysely<WorkspaceDatabase>(db)
    .selectFrom("claw_workspace_files")
    .select([
      "schema_version",
      "agent_id",
      "workspace",
      "target_path",
      "source_path",
      "content_digest",
      "status",
      "created_at_ms",
      "updated_at_ms",
    ]);
}

function rowToWorkspaceFile(
  row: WorkspaceFileRow,
  schemaVersion: PersistedClawWorkspaceFile["schemaVersion"] = CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
): PersistedClawWorkspaceFile {
  return {
    schemaVersion,
    agentId: row.agent_id,
    workspace: row.workspace,
    path: row.target_path,
    sourcePath: row.source_path,
    contentDigest: row.content_digest,
    // SAFETY: Inventory keeps its unchecked status contract; the retry reader validates it first.
    status: row.status as PersistedClawWorkspaceFile["status"],
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

export function workspaceFileToRow(record: PersistedClawWorkspaceFile): WorkspaceFileRow {
  return {
    agent_id: record.agentId,
    target_path: record.path,
    schema_version: record.schemaVersion,
    workspace: record.workspace,
    source_path: record.sourcePath,
    content_digest: record.contentDigest,
    status: record.status,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
  };
}

export function readAllClawWorkspaceFilesInDatabase(
  db: EngineConnection,
): PersistedClawWorkspaceFile[] {
  if (!tableExists(db, "claw_workspace_files")) {
    return [];
  }
  const compiled = selectWorkspaceFiles(db).orderBy("agent_id").orderBy("target_path").compile();
  const rows =
    db /* sqlite-allow-raw: preserve native orphan inventory errors without a write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and shared explicit projection provide this generated row shape.
      .all() as WorkspaceFileRow[];
  // Orphan inventory reports the stored version; per-agent inventory uses the current constant.
  return rows.map(
    (row) =>
      rowToWorkspaceFile(row, row.schema_version as PersistedClawWorkspaceFile["schemaVersion"]), // SAFETY: Inventory preserves the stored version for the caller to inspect without mutating it.
  );
}

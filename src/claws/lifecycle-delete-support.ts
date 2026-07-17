import type { DatabaseSync } from "node:sqlite";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { pruneAgentConfig } from "../commands/agents.config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

type WorkspaceFileRow = {
  schema_version: string;
  agent_id: string;
  workspace: string;
  target_path: string;
  source_path: string;
  content_digest: string;
  status: PersistedClawWorkspaceFile["status"];
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db /* sqlite-allow-raw: schema probe for optional Claw state tables. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

function rowToWorkspaceFile(row: WorkspaceFileRow): PersistedClawWorkspaceFile {
  return {
    schemaVersion: row.schema_version as PersistedClawWorkspaceFile["schemaVersion"],
    agentId: row.agent_id,
    workspace: row.workspace,
    path: row.target_path,
    sourcePath: row.source_path,
    contentDigest: row.content_digest,
    status: row.status,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function readAllClawWorkspaceFiles(
  options: OpenClawStateDatabaseOptions,
): PersistedClawWorkspaceFile[] {
  const database = openOpenClawStateDatabase(options);
  if (!tableExists(database.db, "claw_workspace_files")) {
    return [];
  }
  const rows = database.db /* sqlite-allow-raw: read-only Claw workspace-file orphan inventory. */
    .prepare(
      `SELECT schema_version, agent_id, workspace, target_path, source_path,
              content_digest, status, created_at_ms, updated_at_ms
         FROM claw_workspace_files
        ORDER BY agent_id, target_path`,
    )
    .all() as WorkspaceFileRow[];
  return rows.map(rowToWorkspaceFile);
}

export function synthesizeOrphanInstall(params: {
  agentId: string;
  clawName?: string;
  workspace?: string;
  updatedAtMs?: number;
}): PersistedClawInstall {
  const updatedAtMs = params.updatedAtMs ?? 0;
  return {
    schemaVersion: "openclaw.clawInstallRecord.v1" as PersistedClawInstall["schemaVersion"],
    claw: {
      kind: "development",
      name: params.clawName ?? `orphan:${params.agentId}`,
      version: "0.0.0",
      packageRoot: "",
      manifestPath: "",
      integrityKind: "development-snapshot",
      integrity: "sha256:orphan",
      byteLength: 0,
    },
    manifestSchemaVersion: 1,
    planIntegrity: "sha256:orphan",
    agentId: params.agentId,
    workspace: params.workspace ?? "",
    agentConfigDigest: "sha256:missing",
    agentOwnedPaths: [],
    status: "partial",
    addedAtMs: updatedAtMs,
    updatedAtMs,
  };
}

export function deletionEffects(config: OpenClawConfig, agentId: string) {
  const agent = config.agents?.list?.find((candidate) => candidate.id === agentId);
  const pruned = pruneAgentConfig(config, agentId);
  const workspace = agent ? (agent.workspace ?? "") : "";
  const agentDir = agent ? resolveAgentDir(config, agentId) : "";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const workspaceSharedWith = workspace
    ? findOverlappingWorkspaceAgentIds(config, agentId, workspace)
    : [];
  return {
    pruned,
    workspace,
    agentDir,
    sessionsDir,
    workspaceSharedWith,
    workspaceRetained: workspaceSharedWith.length > 0,
  };
}

export const clawRemoveQuietRuntime: RuntimeEnv = {
  log: (..._args: unknown[]) => undefined,
  error: (..._args: unknown[]) => undefined,
  exit: (code?: number): never => {
    throw new Error(`Unexpected exit during Claw removal cleanup: ${code ?? 1}`);
  },
};

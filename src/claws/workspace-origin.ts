// Durable record of which Claw workspaces were adopted rather than created by the install.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan } from "./types.js";

type WorkspaceOriginDatabase = Pick<OpenClawStateKyselyDatabase, "claw_workspace_files">;

// Older releases treat every workspace-file row as a removable file. Pointing the reserved row at
// the directory itself makes those releases fail closed during file inspection instead of
// deleting an adopted workspace whose origin they cannot understand.
export const CLAW_ADOPTED_WORKSPACE_MARKER_PATH = ".";
const CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST = "openclaw:adopted-workspace";
const CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION = "openclaw.clawWorkspaceFileRecord.v1";

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorkspaceOriginDatabase>(db);
}

/** True when the consented plan adopts an existing directory instead of creating one. */
export function planAdoptsWorkspace(plan: ClawAddPlan): boolean {
  return plan.actions.some((action) => action.kind === "workspace" && action.action === "adopt");
}

/** The declared-file ids the consented plan adopts (claims as already present), sorted. */
function consentedAdoptedFileIds(plan: ClawAddPlan): string[] {
  return plan.actions
    .filter((action) => action.kind === "workspaceFile" && action.action === "adopt")
    .map((action) => action.id)
    .toSorted();
}

/** Records the downgrade fence inside the caller's open install-record transaction. */
function recordAdoptedWorkspaceRow(params: {
  db: DatabaseSync;
  agentId: string;
  workspace: string;
  adoptedFiles: string[];
  nowMs: number;
}): void {
  // The consented adopted set is stored here, not derived from ownership rows: adopted and
  // written files persist identically shaped rows, so a retried adoption plan (rebuilt after a
  // later-phase failure) needs this to tell which declared destinations it may re-label "adopt".
  const sourcePath = JSON.stringify(params.adoptedFiles);
  executeSqliteQuerySync(
    params.db,
    kyselyFor(params.db)
      .insertInto("claw_workspace_files")
      .values({
        agent_id: params.agentId,
        target_path: CLAW_ADOPTED_WORKSPACE_MARKER_PATH,
        schema_version: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        workspace: params.workspace,
        source_path: sourcePath,
        content_digest: CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST,
        status: "complete",
        created_at_ms: params.nowMs,
        updated_at_ms: params.nowMs,
      })
      .onConflict((conflict) =>
        conflict.columns(["agent_id", "target_path"]).doUpdateSet({
          schema_version: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
          workspace: params.workspace,
          source_path: sourcePath,
          content_digest: CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST,
          status: "complete",
          created_at_ms: params.nowMs,
          updated_at_ms: params.nowMs,
        }),
      ),
  );
}

/** Persists whether this install adopted or created its workspace in the caller's transaction. */
export function persistClawWorkspaceOrigin(params: {
  db: DatabaseSync;
  plan: ClawAddPlan;
  nowMs: number;
}): void {
  if (planAdoptsWorkspace(params.plan)) {
    recordAdoptedWorkspaceRow({
      db: params.db,
      agentId: params.plan.agent.finalId,
      workspace: params.plan.agent.workspace,
      adoptedFiles: consentedAdoptedFileIds(params.plan),
      nowMs: params.nowMs,
    });
    return;
  }
  deleteAdoptedWorkspaceRow(params.db, params.plan.agent.finalId);
}

/** Drops the adopted-workspace marker inside the caller's open write transaction. */
export function deleteAdoptedWorkspaceRow(db: DatabaseSync, agentId: string): void {
  executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .deleteFrom("claw_workspace_files")
      .where("agent_id", "=", agentId)
      .where("target_path", "=", CLAW_ADOPTED_WORKSPACE_MARKER_PATH),
  );
}

export type ClawWorkspaceAdoption =
  | { adopted: false }
  | { adopted: true; adoptedFiles: readonly string[] };

/**
 * Whether this agent's current workspace directory existed before the Claw adopted it, and,
 * when adopted, the consented declared-file ids a resume must relabel "adopt" to reconstruct
 * the identical plan. The stored set is unshipped; a non-JSON value fails closed, no compat.
 */
export function readClawWorkspaceAdoption(
  agentId: string,
  workspace: string,
  options: OpenClawStateDatabaseOptions = {},
): ClawWorkspaceAdoption {
  const { db } = openOpenClawStateDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kyselyFor(db)
      .selectFrom("claw_workspace_files")
      .select("source_path")
      .where("agent_id", "=", agentId)
      .where("target_path", "=", CLAW_ADOPTED_WORKSPACE_MARKER_PATH)
      .where("workspace", "=", workspace)
      .where("content_digest", "=", CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST),
  );
  if (!row) {
    return { adopted: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.source_path);
  } catch {
    throw new Error(
      `Claw adopted-workspace marker for agent ${JSON.stringify(agentId)} has a non-JSON consented file list.`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(
      `Claw adopted-workspace marker for agent ${JSON.stringify(agentId)} has a malformed consented file list.`,
    );
  }
  return { adopted: true, adoptedFiles: parsed };
}

/** True when this agent's current workspace directory existed before the Claw adopted it. */
export function clawWorkspaceWasAdopted(
  agentId: string,
  workspace: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return readClawWorkspaceAdoption(agentId, workspace, options).adopted;
}

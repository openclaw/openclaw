// Durable record of which Claw workspaces were adopted rather than created by the install.
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
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
  // bootstrapSeeded starts false: only a successful seed by *this* install may flip it, so an
  // operator-created identical BOOTSTRAP.md can never be mistaken for an already-seeded one.
  const sourcePath = JSON.stringify({ adoptedFiles: params.adoptedFiles, bootstrapSeeded: false });
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
  | { adopted: true; adoptedFiles: readonly string[]; bootstrapSeeded: boolean };

function selectWorkspaceOriginRow(
  db: DatabaseSync,
  agentId: string,
  workspace: string,
): { source_path: string } | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    kyselyFor(db)
      .selectFrom("claw_workspace_files")
      .select("source_path")
      .where("agent_id", "=", agentId)
      .where("target_path", "=", CLAW_ADOPTED_WORKSPACE_MARKER_PATH)
      .where("workspace", "=", workspace)
      .where("content_digest", "=", CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST),
  );
}

/** The marker's stored shape is unshipped: a non-object or malformed value fails closed, no compat. */
function parseWorkspaceOriginMarker(
  agentId: string,
  sourcePath: string,
): { adoptedFiles: string[]; bootstrapSeeded: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourcePath);
  } catch {
    throw new Error(
      `Claw adopted-workspace marker for agent ${JSON.stringify(agentId)} has a non-JSON consented record.`,
    );
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.adoptedFiles) ||
    parsed.adoptedFiles.some((value) => typeof value !== "string") ||
    typeof parsed.bootstrapSeeded !== "boolean"
  ) {
    throw new Error(
      `Claw adopted-workspace marker for agent ${JSON.stringify(agentId)} has a malformed consented record.`,
    );
  }
  return { adoptedFiles: parsed.adoptedFiles, bootstrapSeeded: parsed.bootstrapSeeded };
}

/**
 * Whether this agent's current workspace directory existed before the Claw adopted it, and,
 * when adopted, the consented declared-file ids a resume must relabel "adopt" to reconstruct
 * the identical plan, plus whether this install itself already seeded BOOTSTRAP.md.
 */
export function readClawWorkspaceAdoptionFromDatabase(
  db: DatabaseSync,
  agentId: string,
  workspace: string,
): ClawWorkspaceAdoption {
  // Read-only previews may run against schema-compatible but pre-migration state where this
  // table does not exist yet; absence reads as "not adopted", not a hard failure.
  if (!tableExists(db, "claw_workspace_files")) {
    return { adopted: false };
  }
  const row = selectWorkspaceOriginRow(db, agentId, workspace);
  if (!row) {
    return { adopted: false };
  }
  return { adopted: true, ...parseWorkspaceOriginMarker(agentId, row.source_path) };
}

export function readClawWorkspaceAdoption(
  agentId: string,
  workspace: string,
  options: OpenClawStateDatabaseOptions = {},
): ClawWorkspaceAdoption {
  const { db } = openOpenClawStateDatabase(options);
  return readClawWorkspaceAdoptionFromDatabase(db, agentId, workspace);
}

/**
 * Flips the marker's bootstrapSeeded flag once this install actually writes BOOTSTRAP.md, so a
 * later resume can tell its own seed apart from an operator-created file with the same content.
 * Must affect exactly the one marker row created for this agent/workspace, or it throws.
 */
export function recordClawBootstrapSeeded(
  agentId: string,
  workspace: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const row = selectWorkspaceOriginRow(db, agentId, workspace);
    if (!row) {
      throw new Error(
        `Claw adopted-workspace marker for agent ${JSON.stringify(agentId)} is missing; cannot record the bootstrap seed.`,
      );
    }
    const marker = parseWorkspaceOriginMarker(agentId, row.source_path);
    const result = executeSqliteQuerySync(
      db,
      kyselyFor(db)
        .updateTable("claw_workspace_files")
        .set({
          source_path: JSON.stringify({ adoptedFiles: marker.adoptedFiles, bootstrapSeeded: true }),
          updated_at_ms: options.nowMs ?? Date.now(),
        })
        .where("agent_id", "=", agentId)
        .where("target_path", "=", CLAW_ADOPTED_WORKSPACE_MARKER_PATH)
        .where("workspace", "=", workspace)
        .where("content_digest", "=", CLAW_ADOPTED_WORKSPACE_MARKER_DIGEST),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(
        `Claw adopted-workspace marker for agent ${JSON.stringify(agentId)} did not update exactly one row.`,
      );
    }
  }, options);
}

/** True when this agent's current workspace directory existed before the Claw adopted it. */
export function clawWorkspaceWasAdopted(
  agentId: string,
  workspace: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return readClawWorkspaceAdoption(agentId, workspace, options).adopted;
}

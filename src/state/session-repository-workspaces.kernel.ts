import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable, Updateable } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { ensureSessionRepositoryWorkspaceSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB, SessionRepositoryWorkspaces } from "./openclaw-state-db.generated.js";
import type {
  RepositoryWorkspaceBase,
  RepositoryWorkspaceCheckpoint,
  RepositoryWorkspaceCreate,
  RepositoryWorkspaceMutation,
  RepositoryWorkspaceMutationResult,
  RepositoryWorkspaceOwner,
  RepositoryWorkspacePublishedHead,
  SessionRepositoryWorkspaceRecord,
} from "./session-repository-workspaces.types.js";

const table = "session_repository_workspaces";
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);
const manifestPattern = /^sha256:[a-f0-9]{64}$/u;
const resultRefPattern = /^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u;

function bounded(value: string, field: string, limit: number): string {
  const result = value.trim();
  if (!result || result.length > limit || /\p{Cc}/u.test(result)) {
    throw new Error(`Repository workspace ${field} is invalid`);
  }
  return result;
}

function project(row: Selectable<SessionRepositoryWorkspaces>): SessionRepositoryWorkspaceRecord {
  return {
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    url: row.url,
    requestedRef: row.requested_ref,
    runSetupScript: row.run_setup_script === 1,
    baseCommit: row.base_commit,
    baseManifestHash: row.base_manifest_hash,
    branch: row.branch,
    checkpointRef: row.checkpoint_ref,
    manifestHash: row.manifest_hash,
    revision: row.revision,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function readSessionRepositoryWorkspaceInDatabase(
  db: DatabaseSync,
  workspaceId: string,
): SessionRepositoryWorkspaceRecord | undefined {
  if (!tableExists(db, table)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db).selectFrom(table).selectAll().where("workspace_id", "=", workspaceId),
  );
  return row ? project(row) : undefined;
}

export function findSessionRepositoryWorkspaceInDatabase(
  db: DatabaseSync,
  owner: RepositoryWorkspaceOwner,
): SessionRepositoryWorkspaceRecord | undefined {
  if (!tableExists(db, table)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("agent_id", "=", owner.agentId)
      .where("session_key", "=", owner.sessionKey),
  );
  return row ? project(row) : undefined;
}

function changed(workspace: SessionRepositoryWorkspaceRecord): RepositoryWorkspaceMutationResult {
  return {
    workspaceId: workspace.workspaceId,
    workspace,
    owner: { agentId: workspace.agentId, sessionKey: workspace.sessionKey },
    changed: true,
  };
}

/** The caller owns the synchronous transaction and its live commit admission. */
export function createSessionRepositoryWorkspaceInDatabase(
  db: DatabaseSync,
  input: RepositoryWorkspaceCreate,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  const agentId = bounded(input.agentId, "agent id", 128);
  const sessionKey = bounded(input.sessionKey, "session key", 1024);
  const url = bounded(input.url, "URL", 4096);
  const requestedRef =
    input.requestedRef === undefined ? null : bounded(input.requestedRef, "ref", 1024);
  const branch = input.branch === undefined ? undefined : bounded(input.branch, "branch", 256);
  const branchPrefix = input.branchPrefix ?? "openclaw";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(branchPrefix)) {
    throw new Error("Repository branch prefix is invalid");
  }
  if (!tableExists(db, table)) {
    ensureSessionRepositoryWorkspaceSchema(db);
  }
  const existing = findSessionRepositoryWorkspaceInDatabase(db, { agentId, sessionKey });
  if (existing) {
    if (
      existing.url !== url ||
      existing.requestedRef !== requestedRef ||
      (branch !== undefined && existing.branch !== branch)
    ) {
      throw new Error("Session already owns a different repository workspace");
    }
    return { ...changed(existing), changed: false };
  }
  const workspaceId = randomUUID();
  const inserted = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .insertInto(table)
      .values({
        workspace_id: workspaceId,
        agent_id: agentId,
        session_key: sessionKey,
        url,
        requested_ref: requestedRef,
        run_setup_script: input.runSetupScript ? 1 : 0,
        base_commit: null,
        base_manifest_hash: null,
        branch: branch ?? `${branchPrefix}/${workspaceId}`,
        checkpoint_ref: null,
        manifest_hash: null,
        revision: 0,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      })
      .returningAll(),
  );
  if (!inserted) {
    throw new Error("Repository workspace creation failed");
  }
  return changed(project(inserted));
}

function mutate(
  db: DatabaseSync,
  input: RepositoryWorkspaceMutation,
  nowMs: number,
  values: (current: SessionRepositoryWorkspaceRecord) => Updateable<SessionRepositoryWorkspaces>,
): RepositoryWorkspaceMutationResult {
  const current = readSessionRepositoryWorkspaceInDatabase(db, input.workspaceId);
  if (!current || current.revision !== input.expectedRevision) {
    throw new Error("Repository workspace revision changed");
  }
  if (!Number.isSafeInteger(current.revision + 1)) {
    throw new Error("Repository workspace revision is exhausted");
  }
  const patch = values(current);
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ ...patch, revision: current.revision + 1, updated_at_ms: nowMs })
      .where("workspace_id", "=", input.workspaceId)
      .where("revision", "=", input.expectedRevision)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("Repository workspace revision changed");
  }
  return changed(project(updated));
}

export function bindSessionRepositoryWorkspaceBaseInDatabase(
  db: DatabaseSync,
  input: RepositoryWorkspaceBase,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  if (
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.baseCommit) ||
    (input.baseManifestHash !== undefined && !manifestPattern.test(input.baseManifestHash))
  ) {
    throw new Error("Repository workspace base is invalid");
  }
  return mutate(db, input, nowMs, (current) => {
    if (
      (current.baseCommit !== null && current.baseCommit !== input.baseCommit) ||
      (current.baseManifestHash !== null &&
        input.baseManifestHash !== undefined &&
        current.baseManifestHash !== input.baseManifestHash)
    ) {
      throw new Error("Repository workspace base changed");
    }
    return {
      base_commit: input.baseCommit,
      ...(input.baseManifestHash ? { base_manifest_hash: input.baseManifestHash } : {}),
    };
  });
}

export function acceptSessionRepositoryWorkspaceCheckpointInDatabase(
  db: DatabaseSync,
  input: RepositoryWorkspaceCheckpoint,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  if (!resultRefPattern.test(input.checkpointRef) || !manifestPattern.test(input.manifestHash)) {
    throw new Error("Repository workspace checkpoint is invalid");
  }
  return mutate(db, input, nowMs, (current) => {
    if (!current.baseCommit || !current.baseManifestHash) {
      throw new Error("Repository workspace base has not been captured");
    }
    return {
      checkpoint_ref: input.checkpointRef,
      manifest_hash: input.manifestHash,
      ...(input.branch ? { branch: bounded(input.branch, "branch", 256) } : {}),
    };
  });
}

export function discardSessionRepositoryWorkspaceCheckpointInDatabase(
  db: DatabaseSync,
  input: RepositoryWorkspaceMutation,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  return mutate(db, input, nowMs, () => ({ checkpoint_ref: null, manifest_hash: null }));
}

export function advanceSessionRepositoryWorkspaceToPublishedHeadInDatabase(
  db: DatabaseSync,
  input: RepositoryWorkspacePublishedHead,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  const branch = bounded(input.branch, "branch", 256);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.headCommit)) {
    throw new Error("Repository workspace published head is invalid");
  }
  return mutate(db, input, nowMs, (current) => {
    if (current.branch !== branch) {
      throw new Error("Repository workspace publication branch changed");
    }
    return {
      requested_ref: input.preserveRequestedRef ? current.requestedRef : branch,
      base_commit: input.headCommit,
      base_manifest_hash: null,
      checkpoint_ref: null,
      manifest_hash: null,
    };
  });
}

export function deleteSessionRepositoryWorkspaceInDatabase(
  db: DatabaseSync,
  workspaceId: string,
): RepositoryWorkspaceMutationResult {
  const deleted = tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db).deleteFrom(table).where("workspace_id", "=", workspaceId).returningAll(),
      )
    : undefined;
  return {
    workspaceId,
    workspace: undefined,
    owner: deleted ? { agentId: deleted.agent_id, sessionKey: deleted.session_key } : undefined,
    changed: deleted !== undefined,
  };
}

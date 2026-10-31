import { randomUUID } from "node:crypto";
import type { Selectable, Updateable } from "kysely";
import { REPOSITORY_BRANCH_PREFIX_PATTERN } from "../config/repository-branch-prefix.js";
import { readWorkerPlacementMovesReadOnly } from "../gateway/worker-environments/placement-move-row-codec.js";
import { getRequired } from "../gateway/worker-environments/placement-row-codec.js";
import {
  matchesWorkspaceResultClaim,
  pendingResultFromRow,
} from "../gateway/worker-environments/placement-workspace-result-owner.js";
import { findWorkerEnvironment } from "../gateway/worker-environments/store-row-codec.js";
import {
  createSqliteQueryCache,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { ensureSessionRepositoryWorkspaceSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB, SessionRepositoryWorkspaces } from "./openclaw-state-db.generated.js";
import {
  assertRepositoryWorkspaceDiskIdentity,
  requireRepositoryWorkspaceDiskAuthority,
} from "./session-repository-workspaces.authority.js";
import { repositoryWorkspacePublication } from "./session-repository-workspaces.receipts.js";
import type {
  RepositoryWorkspaceBase,
  RepositoryWorkspaceCheckpoint,
  RepositoryWorkspaceCreate,
  RepositoryWorkspaceDiskBinding,
  RepositoryWorkspaceDiskRetirement,
  RepositoryWorkspaceMutation,
  RepositoryWorkspaceMutationResult,
  RepositoryWorkspaceOwner,
  SessionRepositoryWorkspaceRecord,
} from "./session-repository-workspaces.types.js";

const table = "session_repository_workspaces";
const query = (db: EngineConnection) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);
const findByOwner = createSqliteQueryCache((db) =>
  prepareSqliteQueryTakeFirstSync<
    RepositoryWorkspaceOwner,
    Selectable<SessionRepositoryWorkspaces>
  >(db, (parameter) =>
    query(db)
      .selectFrom(table)
      .selectAll()
      .where(
        "agent_id",
        "=",
        parameter((owner) => owner.agentId),
      )
      .where(
        "session_key",
        "=",
        parameter((owner) => owner.sessionKey),
      ),
  ),
);
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
    ...(row.disk_authority_json !== null
      ? {
          diskAuthority: requireRepositoryWorkspaceDiskAuthority(
            JSON.parse(row.disk_authority_json),
          ),
        }
      : {}),
    revision: row.revision,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function readSessionRepositoryWorkspaceInDatabase(
  db: EngineConnection,
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
  db: EngineConnection,
  owner: RepositoryWorkspaceOwner,
): SessionRepositoryWorkspaceRecord | undefined {
  if (!tableExists(db, table)) {
    return undefined;
  }
  const row = findByOwner(db)(owner);
  return row ? project(row) : undefined;
}

function changed(
  db: EngineConnection,
  workspace: SessionRepositoryWorkspaceRecord,
): RepositoryWorkspaceMutationResult {
  repositoryWorkspacePublication.stagePostimages(db, [workspace]);
  return {
    workspaceId: workspace.workspaceId,
    workspace,
    owner: { agentId: workspace.agentId, sessionKey: workspace.sessionKey },
    changed: true,
  };
}

/** The caller owns the synchronous transaction and its live commit admission. */
export function createSessionRepositoryWorkspaceInDatabase(
  db: EngineConnection,
  input: RepositoryWorkspaceCreate,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  const agentId = bounded(input.agentId, "agent id", 128);
  const sessionKey = bounded(input.sessionKey, "session key", 1024);
  const url = bounded(input.url, "URL", 4096);
  const requestedRef =
    input.requestedRef === undefined ? null : bounded(input.requestedRef, "ref", 1024);
  const branch = input.branch === undefined ? undefined : bounded(input.branch, "branch", 256);
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
    return { ...changed(db, existing), changed: false };
  }
  const branchPrefix = input.branchPrefix ?? "openclaw";
  if (branch === undefined && !REPOSITORY_BRANCH_PREFIX_PATTERN.test(branchPrefix)) {
    throw new Error("Repository branch prefix is invalid");
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
  return changed(db, project(inserted));
}

function mutate(
  db: EngineConnection,
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
  return changed(db, project(updated));
}

export function bindSessionRepositoryWorkspaceBaseInDatabase(
  db: EngineConnection,
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
  db: EngineConnection,
  input: RepositoryWorkspaceCheckpoint,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  if (!resultRefPattern.test(input.checkpointRef) || !manifestPattern.test(input.manifestHash)) {
    throw new Error("Repository workspace checkpoint is invalid");
  }
  return mutate(db, input, nowMs, (current) => {
    if (current.diskAuthority) {
      throw new Error("A disk-authoritative repository cannot accept a mirrored checkpoint");
    }
    if (!current.baseCommit || !current.baseManifestHash) {
      throw new Error("Repository workspace base has not been captured");
    }
    return { checkpoint_ref: input.checkpointRef, manifest_hash: input.manifestHash };
  });
}

/** Activation calls this in the placement transaction after its active postimage exists. */
export function bindSessionRepositoryWorkspaceDiskInDatabase(
  db: EngineConnection,
  input: RepositoryWorkspaceDiskBinding,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  const authority = requireRepositoryWorkspaceDiskAuthority(input.diskAuthority);
  return mutate(db, input, nowMs, (current) => {
    if (current.diskAuthority) {
      throw new Error("Repository workspace disk authority is immutable");
    }
    if (!current.baseCommit || !current.baseManifestHash) {
      throw new Error("Repository workspace base has not been captured");
    }
    const placements = getNodeSqliteKysely<DB>(db);
    const placement = executeSqliteQueryTakeFirstSync(
      db,
      placements
        .selectFrom("worker_session_placements")
        .selectAll()
        .where("environment_id", "=", authority.environmentId)
        .where("agent_id", "=", current.agentId)
        .where("session_key", "=", current.sessionKey),
    );
    const environment = findWorkerEnvironment(db, authority.environmentId);
    assertRepositoryWorkspaceDiskIdentity(authority, environment);
    if (
      !placement ||
      placement.state !== "active" ||
      placement.environment_id !== authority.environmentId ||
      placement.active_owner_epoch !== environment?.ownerEpoch ||
      environment?.state !== "attached" ||
      environment.destroyRequestedAtMs !== null ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== placement.session_id
    ) {
      throw new Error("Repository workspace disk has no exact session attachment");
    }
    if (
      executeSqliteQueryTakeFirstSync(
        db,
        placements
          .selectFrom("worker_workspace_pending_results")
          .innerJoin(
            "worker_session_placements",
            "worker_session_placements.session_id",
            "worker_workspace_pending_results.session_id",
          )
          .select("worker_workspace_pending_results.session_id")
          .where("worker_session_placements.agent_id", "=", current.agentId)
          .where("worker_session_placements.session_key", "=", current.sessionKey),
      )
    ) {
      throw new Error("Settle the pending mirrored workspace result before binding disk authority");
    }
    if (placement.turn_claim_id !== null) {
      throw new Error("Finish the active workspace turn before binding disk authority");
    }
    return { disk_authority_json: JSON.stringify(authority) };
  });
}

/** Local session binding is verified by the materializer's retained source at both grants. */
export function retireSessionRepositoryWorkspaceDiskInDatabase(
  db: EngineConnection,
  input: RepositoryWorkspaceDiskRetirement,
  nowMs: number,
): RepositoryWorkspaceMutationResult {
  if (!resultRefPattern.test(input.checkpointRef) || !manifestPattern.test(input.manifestHash)) {
    throw new Error("Repository disk export is invalid");
  }
  return mutate(db, input, nowMs, (repository) => {
    const { claim } = input;
    const placement = getRequired(db, claim.sessionId);
    const pending = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("worker_workspace_pending_results")
        .selectAll()
        .where("session_id", "=", claim.sessionId),
    );
    const move = readWorkerPlacementMovesReadOnly(db, [claim.sessionId]).get(claim.sessionId);
    if (
      !repository.diskAuthority ||
      placement.state !== "draining" ||
      !pending ||
      !matchesWorkspaceResultClaim(placement, pendingResultFromRow(pending), claim) ||
      placement.agentId !== repository.agentId ||
      placement.sessionKey !== repository.sessionKey ||
      move?.target.kind !== "gateway" ||
      move.abandonSource ||
      move.source.environmentId !== placement.environmentId ||
      move.source.ownerEpoch !== placement.activeOwnerEpoch ||
      move.source.generation + 1 !== placement.generation ||
      claim.claimId !== claim.runId ||
      !claim.claimId.startsWith("reclaim-") ||
      pending.repository_workspace_id !== repository.workspaceId ||
      pending.staged_result_ref !== input.checkpointRef ||
      pending.repository_disk_authority_json === null
    ) {
      throw new Error("Repository disk retirement lost its exact Gateway move result");
    }
    const environment = findWorkerEnvironment(db, placement.environmentId);
    assertRepositoryWorkspaceDiskIdentity(repository.diskAuthority, environment);
    assertRepositoryWorkspaceDiskIdentity(
      requireRepositoryWorkspaceDiskAuthority(JSON.parse(pending.repository_disk_authority_json)),
      environment,
    );
    if (
      environment?.state !== "attached" ||
      environment.ownerEpoch !== placement.activeOwnerEpoch ||
      environment.destroyRequestedAtMs !== null ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== placement.sessionId
    ) {
      throw new Error("Repository disk retirement lost its original attachment");
    }
    // The local worktree is already bound. This export is a retained handoff receipt,
    // not a new mirror source; pending-result custody still owns physical retirement.
    return {
      disk_authority_json: null,
      checkpoint_ref: input.checkpointRef,
      manifest_hash: input.manifestHash,
    };
  });
}

export function deleteSessionRepositoryWorkspaceInDatabase(
  db: EngineConnection,
  workspaceId: string,
): RepositoryWorkspaceMutationResult {
  const deleted = tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db).deleteFrom(table).where("workspace_id", "=", workspaceId).returningAll(),
      )
    : undefined;
  repositoryWorkspacePublication.stageDeletions(db, [workspaceId]);
  return {
    workspaceId,
    workspace: undefined,
    owner: deleted ? { agentId: deleted.agent_id, sessionKey: deleted.session_key } : undefined,
    changed: deleted !== undefined,
  };
}

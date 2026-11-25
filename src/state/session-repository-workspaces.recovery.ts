import { isDeepStrictEqual } from "node:util";
import type { Selectable } from "kysely";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { repositoryWorkspacePublication } from "./session-repository-workspaces.receipts.js";
import type { RepositoryWorkspaceRecovery as RepositoryWorkspaceLossRecovery } from "./session-repository-workspaces.types.js";

export type RepositoryWorkspaceRecovery = Selectable<DB["session_repository_workspaces"]>;

/** Artifacts must be published first; the offline caller holds exclusive database custody. */
export function restoreRepositoryWorkspaceInDatabase(
  db: EngineConnection,
  source: RepositoryWorkspaceRecovery,
) {
  if (source.disk_authority_json !== null) {
    throw new Error("Retained repository recovery requires its original environment owner");
  }
  const query = getNodeSqliteKysely<Pick<DB, "session_repository_workspaces">>(db);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("session_repository_workspaces")
      .selectAll()
      .where("workspace_id", "=", source.workspace_id),
  );
  const owner = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("session_repository_workspaces")
      .select("workspace_id")
      .where("agent_id", "=", source.agent_id)
      .where("session_key", "=", source.session_key),
  );
  if (
    (existing && !isDeepStrictEqual({ ...existing }, { ...source })) ||
    (owner && owner.workspace_id !== source.workspace_id)
  ) {
    throw new Error("Existing repository workspace conflicts with recovery");
  }
  if (!existing) {
    executeSqliteQuerySync(db, query.insertInto("session_repository_workspaces").values(source));
    repositoryWorkspacePublication.stagePostimages(db, [
      {
        workspaceId: source.workspace_id,
        agentId: source.agent_id,
        sessionKey: source.session_key,
        url: source.url,
        requestedRef: source.requested_ref,
        runSetupScript: source.run_setup_script === 1,
        baseCommit: source.base_commit,
        baseManifestHash: source.base_manifest_hash,
        branch: source.branch,
        checkpointRef: source.checkpoint_ref,
        manifestHash: source.manifest_hash,
        revision: source.revision,
        createdAtMs: source.created_at_ms,
        updatedAtMs: source.updated_at_ms,
        ...(source.recovery_json
          ? { recovery: readRepositoryWorkspaceRecovery(source.recovery_json) }
          : {}),
      },
    ]);
  }
  return { workspaceRestored: !existing };
}

const commit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const manifest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const recoverySchema = z.strictObject({
  reason: z.enum(["missing-checkpoint-artifact", "missing-worker"]),
  atMs: z.number().int().nonnegative(),
  original: z.strictObject({
    revision: z.number().int().nonnegative(),
    baseCommit: commit.nullable(),
    baseManifestHash: manifest.nullable(),
    checkpointRef: z
      .string()
      .regex(/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u)
      .nullable(),
    manifestHash: manifest.nullable(),
  }),
  sourceCommit: commit,
  source: z.enum(["published-branch", "recorded-base"]),
  unrecoverablePrivateContent: z.literal(true),
});

/** Validate persisted metadata once where the database row enters the owner. */
export function readRepositoryWorkspaceRecovery(raw: string): RepositoryWorkspaceLossRecovery {
  return recoverySchema.parse(JSON.parse(raw));
}

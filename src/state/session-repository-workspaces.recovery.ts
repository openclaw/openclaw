import { isDeepStrictEqual } from "node:util";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { repositoryWorkspacePublication } from "./session-repository-workspaces.receipts.js";

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
      },
    ]);
  }
  return { workspaceRestored: !existing };
}

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export type RepositoryGitHubPublicationRow = DB["github_repository_publication_requests"];
const table = "github_repository_publication_requests";
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

export function repositoryGitHubPublicationDigest(row: RepositoryGitHubPublicationRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.request_id,
        row.owner_profile_id,
        row.connection_generation,
        row.idempotency_key,
        row.session_id,
        row.session_lifecycle_revision,
        row.session_key,
        row.agent_id,
        row.workspace_id,
        row.identity_source,
        row.identity_profile_id,
        row.identity_account_id,
        row.identity_login,
        row.title,
        row.body,
        row.push_repository,
        row.repository,
        row.branch,
        row.base_branch,
        row.checkpoint_ref,
        row.checkpoint_digest,
        row.source_head_commit,
        row.source_index_tree,
        row.workspace_tree,
        row.previous_head_commit,
        row.created_at_ms,
      ]),
    )
    .digest("hex");
}

export function checkRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
): RepositoryGitHubPublicationRow {
  if (
    repositoryGitHubPublicationDigest(row) !== row.request_digest ||
    (row.identity_source === "personal") !== (row.owner_profile_id !== null)
  ) {
    throw new Error("GitHub repository publication receipt is corrupt.");
  }
  return row;
}

export type RepositoryGitHubPublicationPendingQuery = {
  ownerProfileId: string;
  sessionKey: string;
  agentId: string;
};

function projectRepositoryGitHubPublicationStatus(row: RepositoryGitHubPublicationRow) {
  return {
    request_id: row.request_id,
    owner_profile_id: row.owner_profile_id,
    connection_generation: row.connection_generation,
    request_digest: row.request_digest,
    session_id: row.session_id,
    session_lifecycle_revision: row.session_lifecycle_revision,
    session_key: row.session_key,
    agent_id: row.agent_id,
    workspace_id: row.workspace_id,
    identity_source: row.identity_source,
    identity_account_id: row.identity_account_id,
    identity_login: row.identity_login,
    status: row.status,
    gateway_instance_id: row.gateway_instance_id,
    execution_id: row.execution_id,
    push_repository: row.push_repository,
    repository: row.repository,
    branch: row.branch,
    base_branch: row.base_branch,
    source_head_commit: row.source_head_commit,
    source_index_tree: row.source_index_tree,
    workspace_tree: row.workspace_tree,
    head_commit: row.head_commit,
    pull_request_url: row.pull_request_url,
    error_code: row.error_code,
    next_action: row.next_action,
    last_effect: row.last_effect,
    effect_state: row.effect_state,
  };
}

export type RepositoryGitHubPublicationStatusRow = ReturnType<
  typeof projectRepositoryGitHubPublicationStatus
>;

type RepositoryGitHubPublicationFilter = {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  workspaceId?: string;
  ownerProfileId?: string | null;
  idempotencyKey?: string;
  pending?: boolean;
  unreported?: boolean;
};

function selectRepositoryGitHubPublications(
  db: DatabaseSync,
  filter: RepositoryGitHubPublicationFilter,
) {
  let selection = query(db).selectFrom(table).selectAll();
  if (filter.sessionId !== undefined) {
    selection = selection.where("session_id", "=", filter.sessionId);
  }
  if (filter.sessionKey !== undefined) {
    selection = selection.where("session_key", "=", filter.sessionKey);
  }
  if (filter.agentId !== undefined) {
    selection = selection.where("agent_id", "=", filter.agentId);
  }
  if (filter.workspaceId !== undefined) {
    selection = selection.where("workspace_id", "=", filter.workspaceId);
  }
  if (filter.ownerProfileId !== undefined) {
    selection = selection.where(
      "owner_profile_id",
      filter.ownerProfileId === null ? "is" : "=",
      filter.ownerProfileId,
    );
  }
  if (filter.idempotencyKey !== undefined) {
    selection = selection.where("idempotency_key", "=", filter.idempotencyKey);
  }
  if (filter.pending !== undefined) {
    selection = selection.where(
      "status",
      "in",
      filter.pending ? ["requested", "publishing", "needs_confirmation"] : ["published", "failed"],
    );
  }
  if (filter.unreported) {
    selection = selection.where("reported_at_ms", "is", null);
  }
  return selection.orderBy("updated_at_ms").orderBy("request_id");
}

export function listRepositoryGitHubPublicationsInDatabase(
  db: DatabaseSync,
  filter: RepositoryGitHubPublicationFilter,
): RepositoryGitHubPublicationRow[] {
  if (!tableExists(db, table)) {
    return [];
  }
  return executeSqliteQuerySync(db, selectRepositoryGitHubPublications(db, filter)).rows.map(
    checkRepositoryGitHubPublication,
  );
}

export function readPendingRepositoryGitHubPublicationInDatabase(
  db: DatabaseSync,
  input: RepositoryGitHubPublicationPendingQuery,
): RepositoryGitHubPublicationStatusRow | undefined {
  if (!tableExists(db, table)) {
    return undefined;
  }
  let latest: RepositoryGitHubPublicationRow | undefined;
  // Older corrupt receipts must still fail the read; only the selected status crosses threads.
  for (const row of iterateSqliteQuerySync(
    db,
    selectRepositoryGitHubPublications(db, { ...input, pending: true }),
  )) {
    latest = checkRepositoryGitHubPublication(row);
  }
  return latest && projectRepositoryGitHubPublicationStatus(latest);
}

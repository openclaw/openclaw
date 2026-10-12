import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  checkRepositoryGitHubPublication,
  projectRepositoryGitHubPublicationStatus,
  type RepositoryGitHubPublicationFilter,
  type RepositoryGitHubPublicationPendingQuery,
  type RepositoryGitHubPublicationStatusRow,
} from "./github-repository-publication.kernel.js";

const table = "github_repository_publication_requests";
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

function selectRepositoryGitHubPublications(
  db: DatabaseSync,
  filter: RepositoryGitHubPublicationFilter,
) {
  let selection = query(db).selectFrom(table).selectAll();
  for (const [column, value] of [
    ["session_id", filter.sessionId],
    ["session_key", filter.sessionKey],
    ["agent_id", filter.agentId],
    ["workspace_id", filter.workspaceId],
    ["owner_profile_id", filter.ownerProfileId],
    ["idempotency_key", filter.idempotencyKey],
  ] as const) {
    if (value !== undefined) {
      selection = selection.where(column, value === null ? "is" : "=", value);
    }
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

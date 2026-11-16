import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { matchesRepositoryGitHubPublicationInput } from "./github-repository-publication.kernel.js";
import type {
  RepositoryGitHubPublicationPendingQuery,
  RepositoryGitHubPublicationStatusRow,
} from "./github-repository-publication.kernel.js";

export { repositoryGitHubPublicationDigest } from "./github-repository-publication.kernel.js";

export async function readPendingRepositoryGitHubPublication(
  input: RepositoryGitHubPublicationPendingQuery,
): Promise<RepositoryGitHubPublicationStatusRow | undefined> {
  const result = await executeExistingOpenClawStateRead(
    {},
    { type: "githubPublications.personalPending", input },
    { current: true },
  );
  return result?.row;
}

export function terminalRepositoryGitHubPublication(
  row: Pick<RepositoryGitHubPublicationRow, "status">,
): boolean {
  return row.status === "published" || row.status === "failed";
}

/** Only an explicit retry can reopen a checkpoint that has no prepared or dispatched effect. */
export function retryableRepositoryGitHubPublication(
  row: RepositoryGitHubPublicationRow,
  managedInput?: RepositoryGitHubPublicationRow,
): boolean {
  return (
    row.owner_profile_id === null &&
    row.status === "failed" &&
    (row.error_code === "unavailable" ||
      ((row.error_code === "push_rejected" ||
        row.error_code === "identity_unavailable" ||
        row.error_code === "workspace_changed") &&
        managedInput !== undefined &&
        matchesRepositoryGitHubPublicationInput(row, managedInput))) &&
    row.checkpoint_ref !== null &&
    row.checkpoint_digest !== null &&
    row.head_commit === null &&
    row.last_effect === null &&
    row.effect_state === null &&
    row.pushed_head_commit === null &&
    row.pull_request_url === null
  );
}

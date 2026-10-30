import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
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

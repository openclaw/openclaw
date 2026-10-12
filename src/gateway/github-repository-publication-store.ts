import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type {
  RepositoryGitHubPublicationPendingQuery,
  RepositoryGitHubPublicationStatusRow,
} from "./github-repository-publication.kernel.js";

export { repositoryGitHubPublicationDigest } from "./github-repository-publication.kernel.js";

export async function readPendingRepositoryGitHubPublication(
  input: RepositoryGitHubPublicationPendingQuery,
): Promise<RepositoryGitHubPublicationStatusRow | undefined> {
  const context = captureOpenClawStateWorkerContext();
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "githubRepository.personalPending",
    input,
  });
}

export function terminalRepositoryGitHubPublication(
  row: Pick<RepositoryGitHubPublicationRow, "status">,
): boolean {
  return row.status === "published" || row.status === "failed";
}

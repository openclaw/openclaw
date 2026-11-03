import type {
  SharedGitHubPublicationReadInput,
  GitHubPublicationReceiptTarget,
  RepositoryGitHubPublicationReceiptTarget,
} from "../state/github-publication-read.types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

type ReceiptReadSource = { path?: string; env?: NodeJS.ProcessEnv };
type ReceiptReadOptions = {
  current?: boolean;
  preferIndependentWarmRead?: true;
  context?: OpenClawStateWorkerContext;
};

export async function readSharedPublicationObservation(
  options: ReceiptReadSource,
  input: SharedGitHubPublicationReadInput,
  readOptions: ReceiptReadOptions = {},
) {
  const result = await executeExistingOpenClawStateRead(
    options,
    { type: "githubPublications.sharedObservation", input },
    readOptions,
  );
  return result ? { row: result.row } : undefined;
}

export async function readPublicationRequestReceipt(
  options: ReceiptReadSource,
  requestId: string,
  readOptions: ReceiptReadOptions = {},
) {
  const result = await executeExistingOpenClawStateRead(
    options,
    { type: "githubPublication.request", requestId },
    readOptions,
  );
  return result ? { row: result.row } : undefined;
}

export async function readPublicationPullRequestUrls(
  options: ReceiptReadSource,
  input: GitHubPublicationReceiptTarget,
  readOptions: ReceiptReadOptions = {},
) {
  const result = await executeExistingOpenClawStateRead(
    options,
    { type: "githubPublication.knownPullRequestUrls", input },
    readOptions,
  );
  return result ? { urls: result.urls } : undefined;
}

export async function readRepositoryPublicationPullRequestUrls(
  options: ReceiptReadSource,
  input: RepositoryGitHubPublicationReceiptTarget,
  readOptions: ReceiptReadOptions = {},
) {
  const result = await executeExistingOpenClawStateRead(
    options,
    { type: "githubRepository.knownPullRequestUrls", input },
    readOptions,
  );
  return result ? { urls: result.urls } : undefined;
}

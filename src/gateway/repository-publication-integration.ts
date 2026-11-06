import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import type { GitHubRepositoryPublicationSnapshot } from "./github-repository-publication-snapshot.js";
import type { WorkerSessionPlacementIdentity } from "./worker-environments/placement-record.js";
import type { RepositoryGitHistory } from "./worker-environments/session-repository-checkpoints.types.js";

export type RepositoryPublicationIntegrationInput = {
  snapshotRoot: string;
  snapshotDigest: string;
  history?: RepositoryGitHistory;
  sourceUrl: string;
  targetUrl: string;
  targetCommit: string;
  token: string;
  readNativeCredential?: GitHubCredentialReader;
  assertCurrent: () => void;
};

export type PrepareRepositoryPublicationIntegration = (
  identity: WorkerSessionPlacementIdentity,
  input: RepositoryPublicationIntegrationInput,
) => Promise<{
  snapshot: GitHubRepositoryPublicationSnapshot;
  snapshotRoot: string;
  release: () => Promise<void>;
}>;

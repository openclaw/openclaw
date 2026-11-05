import type { WorkerWorkspaceGitHistory } from "./workspace-result-inventory.js";
import type { withStagedWorkerWorkspaceManifest } from "./workspace-result-staging.js";

export type RepositoryGitHistory = {
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  gitHistoryNote?: string;
};

type CheckpointSnapshot = Parameters<Parameters<typeof withStagedWorkerWorkspaceManifest>[1]>[0];
export type SessionRepositoryCheckpointPayload = CheckpointSnapshot &
  RepositoryGitHistory & {
    stagingRoot: string;
    publicationStagingRoot?: string;
    publicationDigest?: string;
  };

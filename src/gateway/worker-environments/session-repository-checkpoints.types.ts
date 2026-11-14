import type { WorkerWorkspaceGitHistory } from "./workspace-result-inventory.js";
import type { readStagedWorkerWorkspaceResult } from "./workspace-result-staging.js";

export type RepositoryGitHistory = {
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  gitHistoryNote?: string;
};

type CheckpointSnapshot = Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>>;
export type SessionRepositoryCheckpointPayload = CheckpointSnapshot &
  RepositoryGitHistory & {
    stagingRoot: string;
    publicationStagingRoot?: string;
    publicationDigest?: string;
  };

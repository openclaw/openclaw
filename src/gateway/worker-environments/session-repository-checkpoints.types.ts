import type {
  StagedWorkerWorkspaceInventory,
  WorkerWorkspaceGitHistory,
} from "./workspace-result-inventory.js";

export type RepositoryGitHistory = {
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  gitHistoryNote?: string;
};

export type SessionRepositoryCheckpointPayload = StagedWorkerWorkspaceInventory &
  RepositoryGitHistory & {
    stagingRoot: string;
    publicationStagingRoot?: string;
    publicationDigest?: string;
  };

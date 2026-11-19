import type { repositoryWorkspaceOperations } from "./session-repository-workspaces.worker.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

export type RepositoryWorkspaceWorkerOperations = WorkerOperations<
  typeof repositoryWorkspaceOperations
>;

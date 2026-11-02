import type { RepositoryWorkspaceDiskAuthority } from "../../state/session-repository-workspaces.types.js";

export type WorkerWorkspacePendingResult = {
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
  claimId: string;
  runId: string;
  gatewayInstanceId: string;
  recoveryRequestedAtMs: number | null;
  workspaceAcceptedAtMs: number | null;
  stagedResultRef: string | null;
  repositoryWorkspaceId?: string;
  // Absence is the original mirror result contract, including pre-migration rows.
  // Recovery never substitutes the current repository/environment authority.
  repositoryDiskAuthority?: RepositoryWorkspaceDiskAuthority;
};

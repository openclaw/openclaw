import type { WorkerSessionTurnClaim } from "../gateway/worker-environments/placement-record.js";
import type { WorkerResourceReceipt } from "../plugins/capability-provider.types.js";

/** The retained resource, not a Gateway checkpoint, owns this repository. */
export type RepositoryWorkspaceDiskAuthority = {
  environmentId: string;
  resourceReceipt: WorkerResourceReceipt;
};

export type SessionRepositoryWorkspaceRecord = {
  workspaceId: string;
  agentId: string;
  sessionKey: string;
  url: string;
  requestedRef: string | null;
  runSetupScript: boolean;
  baseCommit: string | null;
  baseManifestHash: string | null;
  branch: string;
  checkpointRef: string | null;
  manifestHash: string | null;
  diskAuthority?: RepositoryWorkspaceDiskAuthority;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type RepositoryWorkspaceOwner = { agentId: string; sessionKey: string };
export type RepositoryWorkspaceCreate = RepositoryWorkspaceOwner & {
  url: string;
  requestedRef?: string;
  runSetupScript?: boolean;
  branchPrefix?: string;
  branch?: string;
};
export type RepositoryWorkspaceMutation = { workspaceId: string; expectedRevision: number };
export type RepositoryWorkspaceDiskBinding = RepositoryWorkspaceMutation & {
  diskAuthority: RepositoryWorkspaceDiskAuthority;
};
export type RepositoryWorkspaceBase = RepositoryWorkspaceMutation & {
  baseCommit: string;
  baseManifestHash?: string;
};
export type RepositoryWorkspaceCheckpoint = RepositoryWorkspaceMutation & {
  checkpointRef: string;
  manifestHash: string;
};

/** The pending result retains the original receipt until exact source cleanup settles. */
export type RepositoryWorkspaceDiskRetirement = RepositoryWorkspaceCheckpoint & {
  claim: WorkerSessionTurnClaim;
};

export type RepositoryWorkspaceMutationResult = {
  workspaceId: string;
  workspace: SessionRepositoryWorkspaceRecord | undefined;
  owner: RepositoryWorkspaceOwner | undefined;
  changed: boolean;
};

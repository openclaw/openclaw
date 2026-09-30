import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";

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
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type RepositoryWorkspaceOwner = { agentId: string; sessionKey: string };
export type RepositoryWorkspaceCreate = RepositoryWorkspaceOwner & {
  url: string;
  requestedRef?: string;
  runSetupScript?: boolean;
  branch?: string;
};
export type RepositoryWorkspaceMutation = { workspaceId: string; expectedRevision: number };
export type RepositoryWorkspaceBase = RepositoryWorkspaceMutation & {
  baseCommit: string;
  baseManifestHash?: string;
};
export type RepositoryWorkspaceCheckpoint = RepositoryWorkspaceMutation & {
  checkpointRef: string;
  manifestHash: string;
};

export type RepositoryWorkspaceMutationResult = {
  workspaceId: string;
  workspace: SessionRepositoryWorkspaceRecord | undefined;
  owner: RepositoryWorkspaceOwner | undefined;
  changed: boolean;
};

export type RepositoryWorkspaceWorkerOperations = {
  "repositoryWorkspaces.get": {
    input: { workspaceId: string };
    output: SessionRepositoryWorkspaceRecord | undefined;
  };
  "repositoryWorkspaces.find": {
    input: RepositoryWorkspaceOwner;
    output: SessionRepositoryWorkspaceRecord | undefined;
  };
  "repositoryWorkspaces.create": {
    input: RepositoryWorkspaceCreate & { nowMs?: number };
    output: RepositoryWorkspaceMutationResult;
  };
  "repositoryWorkspaces.bindBase": {
    input: RepositoryWorkspaceBase & { nowMs?: number };
    output: RepositoryWorkspaceMutationResult;
  };
  "repositoryWorkspaces.acceptCheckpoint": {
    input: RepositoryWorkspaceCheckpoint & { nowMs?: number };
    output: RepositoryWorkspaceMutationResult;
  };
  "repositoryWorkspaces.delete": {
    input: { workspaceId: string; sessionEntryCurrentSource?: SessionEntryCurrentSource };
    output: RepositoryWorkspaceMutationResult;
  };
};

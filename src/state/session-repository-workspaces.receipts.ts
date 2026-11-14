import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { requireRepositoryWorkspaceDiskAuthority } from "./session-repository-workspaces.authority.js";
import type { SessionRepositoryWorkspaceRecord } from "./session-repository-workspaces.types.js";
import { createStateDomainPublication } from "./state-domain-publication.js";

export function isRepositoryWorkspace(value: unknown): value is SessionRepositoryWorkspaceRecord {
  if (isRecord(value) && value.diskAuthority !== undefined) {
    try {
      requireRepositoryWorkspaceDiskAuthority(value.diskAuthority);
    } catch {
      return false;
    }
  }
  return (
    isRecord(value) &&
    ["workspaceId", "agentId", "sessionKey", "url", "branch"].every(
      (key) => typeof value[key] === "string",
    ) &&
    ["requestedRef", "baseCommit", "baseManifestHash", "checkpointRef", "manifestHash"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    ) &&
    typeof value.runSetupScript === "boolean" &&
    ["revision", "createdAtMs", "updatedAtMs"].every((key) => typeof value[key] === "number")
  );
}

export const repositoryWorkspacePublication =
  createStateDomainPublication<SessionRepositoryWorkspaceRecord>({
    domain: "repository-workspace",
    keyOf: (row) => row.workspaceId,
    isValue: isRepositoryWorkspace,
  });

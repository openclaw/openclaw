import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerEnvironmentRecord } from "../gateway/worker-environments/environment-record.js";
import {
  requireWorkerResourceReceipt,
  sameWorkerResourceReceipt,
} from "../plugins/worker-resource-receipt.js";
import type { RepositoryWorkspaceDiskAuthority } from "./session-repository-workspaces.types.js";

export function requireRepositoryWorkspaceDiskAuthority(
  value: unknown,
): RepositoryWorkspaceDiskAuthority {
  if (
    !isRecord(value) ||
    typeof value.environmentId !== "string" ||
    !/^\S{1,128}$/u.test(value.environmentId)
  ) {
    throw new Error("Repository workspace disk authority is invalid");
  }
  return {
    environmentId: value.environmentId,
    resourceReceipt: requireWorkerResourceReceipt(value.resourceReceipt),
  };
}

/** Resource identity is separate from the caller's live placement/operation authority. */
export function assertRepositoryWorkspaceDiskIdentity(
  authority: RepositoryWorkspaceDiskAuthority,
  environment:
    | Pick<WorkerEnvironmentRecord, "environmentId" | "leaseId" | "resourceReceipt">
    | undefined,
): void {
  if (
    environment?.environmentId !== authority.environmentId ||
    environment.leaseId !== authority.resourceReceipt.leaseId ||
    !environment.resourceReceipt ||
    !sameWorkerResourceReceipt(authority.resourceReceipt, environment.resourceReceipt)
  ) {
    throw new Error(
      "Repository workspace disk is missing or changed; preserve the original resource for recovery",
    );
  }
}

import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import {
  requireWorkerRetentionPolicy,
  workerWorkspaceDurabilitySchema,
} from "../../plugins/worker-retention.js";
import type { WorkerRetentionPolicy } from "../../plugins/worker-retention.types.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";

/** Admission binds the selected policy to this namespace and repository before allocation. */
export function prepareWorkerRetentionPolicy(params: {
  projectNamespace?: string;
  workspaceId?: string;
  imageReserve?: boolean;
  profileSnapshot: WorkerProfile;
  provider: WorkerProvider;
  retainedPolicy?: WorkerRetentionPolicy;
}): WorkerRetentionPolicy | undefined {
  const durability = workerWorkspaceDurabilitySchema
    .optional()
    .parse(params.profileSnapshot.workspaceDurability);
  let policy = params.retainedPolicy;
  if (durability?.mode === "retained-disk") {
    if (
      !params.projectNamespace ||
      !params.workspaceId ||
      params.imageReserve ||
      !params.provider.supportsResourceReceipts ||
      !params.provider.requiresNodeEnrollment ||
      !params.provider.setRetainedState ||
      params.profileSnapshot.install !== "bundle"
    ) {
      throw serviceError(
        "invalid_profile",
        "Retained disk durability requires a repository and an exact-resource managed-node lifecycle with bundled installation",
      );
    }
    policy = {
      version: 1,
      ownerBinding: sha256Hex(JSON.stringify([params.projectNamespace, params.workspaceId])),
      computeWindowSeconds: durability.computeWindowSeconds,
    };
  }
  return policy ? requireWorkerRetentionPolicy(policy) : undefined;
}

export function requireAdmittedWorkerRetentionPolicy(
  requested: WorkerRetentionPolicy | undefined,
  admitted: WorkerRetentionPolicy | undefined,
): WorkerRetentionPolicy | undefined {
  const policy =
    requested === undefined && admitted === undefined
      ? undefined
      : requireWorkerRetentionPolicy(requested ?? admitted);
  if (admitted && !isDeepStrictEqual(policy, admitted)) {
    throw serviceError(
      "invalid_profile",
      "Allocation retention policy differs from its admitted intent",
    );
  }
  return policy;
}

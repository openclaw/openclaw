import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxBackendHandle } from "../sandbox/backend-handle.types.js";
import { getSandboxBackendManager } from "../sandbox/backend.js";
import type { SandboxBackendInternalMount } from "../sandbox/backend.types.js";
import {
  readRegistry,
  removeRegistryEntry,
  type SandboxRegistryEntry,
} from "../sandbox/registry.js";
import { isRegisteredRepositoryDestination } from "./repository-provenance.js";

export const PROVISIONING_SCOPE_PREFIX = "worktree-provisioning:";

async function revokeRegisteredProvisioningRuntime(
  entry: SandboxRegistryEntry,
  config: OpenClawConfig,
): Promise<void> {
  const backendId = entry.backendId ?? "docker";
  const manager = getSandboxBackendManager(backendId);
  if (!manager) {
    throw new Error(
      `Managed worktree provisioning runtime ${entry.containerName} uses unavailable backend ${backendId}.`,
    );
  }
  await manager.removeRuntime({
    entry,
    config,
  });
  await removeRegistryEntry(entry.containerName);
}

/**
 * Revoke any provisioning grants stranded by a prior failed cleanup or Gateway crash.
 * The global allocation lease must be held by the caller, so a failure fences every
 * later managed-worktree operation until the exact recorded runtime can be removed.
 */
export async function revokeStaleProvisioningRuntimes(config: OpenClawConfig): Promise<void> {
  const registry = await readRegistry();
  const stale = registry.entries.filter((entry) =>
    entry.sessionKey.startsWith(PROVISIONING_SCOPE_PREFIX),
  );
  const failures: unknown[] = [];
  for (const entry of stale) {
    try {
      await revokeRegisteredProvisioningRuntime(entry, config);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Managed worktree provisioning remains fenced until stale filesystem grants are revoked.",
    );
  }
}

export function buildProvisioningMounts(
  baseMounts: readonly SandboxBackendInternalMount[],
  destination?: string,
  snapshotDir?: string,
): SandboxBackendInternalMount[] {
  return [
    ...baseMounts,
    ...(destination
      ? [{ hostPath: destination, containerPath: destination, readOnly: false }]
      : []),
    ...(snapshotDir
      ? [{ hostPath: snapshotDir, containerPath: snapshotDir, readOnly: false }]
      : []),
  ];
}

export async function resolveAdmittedWorktreeDestination(params: {
  destination: string;
  allocationRoot?: string;
  repositoryAllocationRoot: string;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
}): Promise<string> {
  const resolved = path.resolve(params.destination);
  if (
    !params.allocationRoot &&
    path.dirname(resolved) !== params.repositoryAllocationRoot &&
    !isRegisteredRepositoryDestination({
      env: params.env,
      repoRoot: params.repoRoot,
      destination: resolved,
    })
  ) {
    throw new Error("Managed worktree destination escaped its repository allocation root.");
  }
  await fs.mkdir(resolved, { recursive: true });
  return await fs.realpath(resolved);
}

export function createProvisioningRuntimePool(params: {
  backendId: string;
  create: (
    mounts: readonly SandboxBackendInternalMount[],
    generation: number,
  ) => Promise<SandboxBackendHandle>;
}) {
  const createdBackends = new Map<string, SandboxBackendHandle>();
  let generation = 0;
  let disposed = false;
  return {
    async create(mounts: readonly SandboxBackendInternalMount[]) {
      const created = await params.create(mounts, generation++);
      if (!created.disposeRuntime) {
        throw new Error(
          `Managed worktree Git backend ${params.backendId} cannot revoke provisioning filesystem grants.`,
        );
      }
      createdBackends.set(created.runtimeId, created);
      return created;
    },
    async dispose() {
      if (disposed) {
        return;
      }
      const failures: unknown[] = [];
      for (const created of [...createdBackends.values()].toReversed()) {
        try {
          await created.disposeRuntime?.();
          createdBackends.delete(created.runtimeId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Failed to revoke managed worktree provisioning grants.",
        );
      }
      disposed = true;
    },
  };
}

export async function resolveOperationSnapshotMount(params: {
  requestedEnv: NodeJS.ProcessEnv | undefined;
  canonicalTempRoot: string;
}): Promise<string | undefined> {
  const requestedIndex = params.requestedEnv?.GIT_INDEX_FILE;
  if (!requestedIndex) {
    return undefined;
  }
  const resolvedIndex = path.resolve(requestedIndex);
  const snapshotDir = await fs.realpath(path.dirname(resolvedIndex));
  const snapshotParent = path.dirname(snapshotDir);
  const operationPrivateStateDir =
    snapshotParent === params.canonicalTempRoot && path.basename(snapshotDir).startsWith("index-");
  const operationPrivateWorkerDir =
    snapshotParent === (await fs.realpath(os.tmpdir())) &&
    path.basename(snapshotDir).startsWith("openclaw-git-operation-");
  if (
    path.basename(resolvedIndex) !== "index" ||
    (!operationPrivateStateDir && !operationPrivateWorkerDir)
  ) {
    throw new Error("Managed worktree snapshot index escaped its operation-private staging path.");
  }
  return snapshotDir;
}

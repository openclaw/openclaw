import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxBackendHandle } from "../sandbox/backend-handle.types.js";
import type { SandboxBackendInternalMount } from "../sandbox/backend.types.js";
import { isRegisteredRepositoryDestination } from "./repository-provenance.js";

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
      disposed = true;
      const failures: unknown[] = [];
      for (const created of [...createdBackends.values()].toReversed()) {
        try {
          await created.disposeRuntime?.();
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
  if (
    path.basename(resolvedIndex) !== "index" ||
    path.dirname(snapshotDir) !== params.canonicalTempRoot ||
    !path.basename(snapshotDir).startsWith("index-")
  ) {
    throw new Error("Managed worktree snapshot index escaped its operation-private staging path.");
  }
  return snapshotDir;
}

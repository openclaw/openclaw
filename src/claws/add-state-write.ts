import {
  mergeWorkspaceSetupState,
  type WorkspaceSetupState,
} from "../agents/workspace-state-store.js";
import type { ClawPackageLifecycleLeaseIdentity } from "../state/claw-package-lifecycle-lease.js";
import { readClawInventory } from "./inventory-read.js";
import {
  persistClawPackageRef,
  readClawPackageRefs,
  updateClawPackageRefStatus,
} from "./provenance.js";
import {
  executeClawMutationStateCommand as execute,
  type ClawMutationStateOptions,
} from "./state-mutation-write.js";
import type { PersistedClawWorkspaceFile } from "./workspace-state.js";

export type ClawAddStateOptions = ClawMutationStateOptions;
export type ClawPackageRefStateOptions = ClawAddStateOptions & {
  packageLease?: ClawPackageLifecycleLeaseIdentity;
};

export async function persistClawPackageRefForAdd(
  plan: Parameters<typeof persistClawPackageRef>[0],
  pkg: Parameters<typeof persistClawPackageRef>[1],
  options: NonNullable<Parameters<typeof persistClawPackageRef>[2]> &
    ClawPackageRefStateOptions = {},
): Promise<ReturnType<typeof persistClawPackageRef>> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return persistClawPackageRef(plan, pkg, options);
  }
  if (!options.packageLease) {
    throw new Error("Worker-backed package reference writes require a package lifecycle lease.");
  }
  return execute(options, {
    type: "claws.add.persistPackageRef",
    input: {
      plan,
      pkg,
      packageLease: options.packageLease,
      nowMs: options.nowMs,
      status: options.status,
      relationship: options.relationship,
      origin: options.origin,
      independentOwner: options.independentOwner,
    },
  });
}

export async function updateClawPackageRefStatusForAdd(
  ref: Parameters<typeof updateClawPackageRefStatus>[0],
  status: Parameters<typeof updateClawPackageRefStatus>[1],
  options: NonNullable<Parameters<typeof updateClawPackageRefStatus>[2]> &
    ClawPackageRefStateOptions = {},
): Promise<ReturnType<typeof updateClawPackageRefStatus>> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return updateClawPackageRefStatus(ref, status, options);
  }
  if (!options.packageLease) {
    throw new Error("Worker-backed package reference writes require a package lifecycle lease.");
  }
  return execute(options, {
    type: "claws.add.updatePackageRefStatus",
    input: { ref, packageLease: options.packageLease, status, nowMs: options.nowMs },
  });
}

export async function readClawPackageRefsForAdd(
  options: NonNullable<Parameters<typeof readClawPackageRefs>[0]> & ClawAddStateOptions = {},
): Promise<ReturnType<typeof readClawPackageRefs>> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return readClawPackageRefs(options);
  }
  options.assertCurrent?.();
  const { packages: refs } = await readClawInventory(options);
  options.assertCurrent?.();
  return refs.filter(
    (ref) =>
      (options.agentId === undefined || ref.agentId === options.agentId) &&
      (options.kind === undefined || ref.kind === options.kind) &&
      (options.source === undefined || ref.source === options.source) &&
      (options.ref === undefined || ref.ref === options.ref) &&
      (options.version === undefined || ref.version === options.version) &&
      (options.integrity === undefined || ref.integrity === options.integrity) &&
      (options.status === undefined || ref.status === options.status),
  );
}

export async function readClawWorkspaceFileForAdd(
  agentId: string,
  targetPath: string,
  options: ClawAddStateOptions = {},
): Promise<PersistedClawWorkspaceFile | undefined> {
  options.assertCurrent?.();
  const { workspaceFiles } = await readClawInventory(options);
  options.assertCurrent?.();
  const record = workspaceFiles.find(
    (candidate) => candidate.agentId === agentId && candidate.path === targetPath,
  );
  if (
    record &&
    (record.schemaVersion !== "openclaw.clawWorkspaceFileRecord.v1" ||
      (record.status !== "pending" && record.status !== "complete" && record.status !== "failed"))
  ) {
    throw new Error(
      `Claw workspace file ${JSON.stringify(targetPath)} has unsupported provenance state.`,
    );
  }
  return record;
}

export async function persistClawWorkspaceFileForAdd(
  record: PersistedClawWorkspaceFile,
  options: ClawAddStateOptions = {},
): Promise<void> {
  return execute(options, { type: "claws.add.persistWorkspaceFile", input: { record } });
}

export async function updateClawWorkspaceFileStatusForAdd(
  record: PersistedClawWorkspaceFile,
  expectedStatuses: PersistedClawWorkspaceFile["status"][],
  options: ClawAddStateOptions = {},
): Promise<void> {
  return execute(options, {
    type: "claws.add.updateWorkspaceFileStatus",
    input: { record, expectedStatuses },
  });
}

export async function mergeWorkspaceBootstrapSetupStateForAdd(
  workspaceDir: string,
  bootstrapSeededAt: string,
  nowMs: number,
  options: ClawAddStateOptions = {},
): Promise<WorkspaceSetupState> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return mergeWorkspaceSetupState(workspaceDir, { bootstrapSeededAt }, nowMs, options);
  }
  return execute(options, {
    type: "claws.add.mergeBootstrapSetupState",
    input: { workspaceDir, bootstrapSeededAt, nowMs },
  });
}

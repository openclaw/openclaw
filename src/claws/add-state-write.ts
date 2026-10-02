import {
  mergeWorkspaceSetupState,
  type WorkspaceSetupState,
} from "../agents/workspace-state-store.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import type { ClawPackageLifecycleLeaseIdentity } from "../state/claw-package-lifecycle-lease.js";
import type { PersistedClawCronRef } from "./cron.js";
import { readClawInventory } from "./inventory-read.js";
import type { PersistedClawMcpServerRef } from "./mcp.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawPackageRefs,
  updateClawInstallRecordStatus,
  updateClawPackageRefStatus,
} from "./provenance.js";
import {
  executeClawMutationStateCommand as execute,
  type ClawMutationStateOptions,
} from "./state-mutation-write.js";
import type { ClawAddPlan, ClawCronJob, ClawMcpServer } from "./types.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

export type ClawAddStateOptions = ClawMutationStateOptions;
export type ClawPackageRefStateOptions = ClawAddStateOptions & {
  packageLease?: ClawPackageLifecycleLeaseIdentity;
};

export async function persistClawInstallRecordForAdd(
  plan: Parameters<typeof persistClawInstallRecord>[0],
  options: NonNullable<Parameters<typeof persistClawInstallRecord>[1]> & ClawAddStateOptions = {},
): Promise<ReturnType<typeof persistClawInstallRecord>> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return persistClawInstallRecord(plan, options);
  }
  return execute(options, {
    type: "claws.add.persistInstall",
    input: {
      plan,
      status: options.status,
      nowMs: options.nowMs,
      expectedExistingRecord: options.expectedExistingRecord,
      expectedExistingPlan: options.expectedExistingPlan,
      deferLegacyPlanUpgrade: options.deferLegacyPlanUpgrade,
    },
  });
}

export async function updateClawInstallRecordStatusForAdd(
  agentId: Parameters<typeof updateClawInstallRecordStatus>[0],
  status: Parameters<typeof updateClawInstallRecordStatus>[1],
  options: NonNullable<Parameters<typeof updateClawInstallRecordStatus>[2]> &
    ClawAddStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return updateClawInstallRecordStatus(agentId, status, options);
  }
  return execute(options, {
    type: "claws.add.updateInstallStatus",
    input: { agentId, status, nowMs: options.nowMs, expectedStatuses: options.expectedStatuses },
  });
}

export async function deleteClawInstallRecordForAdd(
  agentId: Parameters<typeof deleteClawInstallRecord>[0],
  options: NonNullable<Parameters<typeof deleteClawInstallRecord>[1]> & ClawAddStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return deleteClawInstallRecord(agentId, options);
  }
  return execute(options, {
    type: "claws.add.deleteInstall",
    input: { agentId, expectedStatuses: options.expectedStatuses },
  });
}

export async function recordAgentProvenanceForAdd(
  agentId: Parameters<typeof recordAgentProvenance>[0],
  provenance: Parameters<typeof recordAgentProvenance>[1],
  options: NonNullable<Parameters<typeof recordAgentProvenance>[2]> & ClawAddStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return recordAgentProvenance(agentId, provenance, options);
  }
  return execute(options, {
    type: "claws.add.recordAgentProvenance",
    input: { agentId, provenance, nowMs: options.nowMs },
  });
}

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
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { readClawWorkspaceFile } = await import("./workspace.js");
    return readClawWorkspaceFile(agentId, targetPath, options);
  }
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
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { persistClawWorkspaceFile } = await import("./workspace.js");
    return persistClawWorkspaceFile(record, options);
  }
  return execute(options, { type: "claws.add.persistWorkspaceFile", input: { record } });
}

export async function updateClawWorkspaceFileStatusForAdd(
  record: PersistedClawWorkspaceFile,
  expectedStatuses: PersistedClawWorkspaceFile["status"][],
  options: ClawAddStateOptions = {},
): Promise<void> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { updateClawWorkspaceFileStatus } = await import("./workspace.js");
    return updateClawWorkspaceFileStatus(record, expectedStatuses, options);
  }
  return execute(options, {
    type: "claws.add.updateWorkspaceFileStatus",
    input: { record, expectedStatuses },
  });
}

export async function readClawMcpServerRefsByNameForAdd(
  name: string,
  options: ClawAddStateOptions = {},
): Promise<PersistedClawMcpServerRef[]> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { readClawMcpServerRefsByName } = await import("./mcp.js");
    return readClawMcpServerRefsByName(name, options);
  }
  options.assertCurrent?.();
  const { mcpServers } = await readClawInventory(options);
  options.assertCurrent?.();
  return mcpServers
    .filter((ref) => ref.name === name)
    .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
}

export async function persistClawMcpPendingRefForAdd(
  plan: ClawAddPlan,
  name: string,
  server: ClawMcpServer,
  ownership: Pick<PersistedClawMcpServerRef, "relationship" | "origin" | "independentOwner">,
  options: ClawAddStateOptions & { nowMs?: number } = {},
): Promise<PersistedClawMcpServerRef> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { persistClawMcpPendingRef } = await import("./mcp.js");
    return persistClawMcpPendingRef(plan, name, server, ownership, options);
  }
  return execute(options, {
    type: "claws.add.persistMcpPendingRef",
    input: { plan, name, server, ownership, nowMs: options.nowMs },
  });
}

export async function updateClawMcpRefForAdd(
  ref: PersistedClawMcpServerRef,
  update: { status: PersistedClawMcpServerRef["status"]; error?: string },
  options: ClawAddStateOptions & { nowMs?: number } = {},
): Promise<PersistedClawMcpServerRef> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { updateClawMcpRef } = await import("./mcp.js");
    return updateClawMcpRef(ref, update, options);
  }
  return execute(options, {
    type: "claws.add.updateMcpRef",
    input: { ref, update, nowMs: options.nowMs },
  });
}

export async function persistClawCronPendingRefForAdd(
  plan: ClawAddPlan,
  job: ClawCronJob,
  options: ClawAddStateOptions & { nowMs?: number } = {},
): Promise<PersistedClawCronRef> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { persistClawCronPendingRef } = await import("./cron.js");
    return persistClawCronPendingRef(plan, job, options);
  }
  return execute(options, {
    type: "claws.add.persistCronPendingRef",
    input: { plan, job, nowMs: options.nowMs },
  });
}

export async function updateClawCronRefForAdd(
  ref: PersistedClawCronRef,
  update: { schedulerJobId?: string; status: PersistedClawCronRef["status"]; error?: string },
  options: ClawAddStateOptions & { nowMs?: number } = {},
): Promise<PersistedClawCronRef> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    const { updateClawCronRef } = await import("./cron.js");
    return updateClawCronRef(ref, update, options);
  }
  return execute(options, {
    type: "claws.add.updateCronRef",
    input: { ref, update, nowMs: options.nowMs },
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

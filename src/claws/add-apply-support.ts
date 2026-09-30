// Shared provenance and workspace-path guards for the Claw add mutation owner.
import type { Stats } from "node:fs";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { partialResult, type ClawAddApplyOptions, type ClawAddResult } from "./add-contract.js";
import { ClawAddMutationError } from "./add-errors.js";
import type { ClawAgentOrigin } from "./provenance-schema-version.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  persistClawInstallRecordWithDisposition,
  updateClawInstallRecordStatus,
  type ClawInstallStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

export function assertApplyLeaseOwned(options: ClawAddApplyOptions): void {
  options.assertApplyLeaseOwned?.();
}

export function persistInitialInstallRecord(
  plan: ClawAddPlan,
  options: ClawAddApplyOptions,
): { record: PersistedClawInstall; created: boolean } {
  assertApplyLeaseOwned(options);
  const persistenceOptions = {
    ...options,
    status: "pending" as const,
    expectedExistingRecord: options.resumeRecord,
    expectedExistingPlan: options.resumePlan,
    deferLegacyPlanUpgrade: options.resumePlan !== undefined,
  };
  // A test override cannot prove atomically that it inserted this row. Treat that result as
  // pre-existing so an error path never deletes ambiguous durable ownership.
  return options.persistRecord
    ? { record: options.persistRecord(plan, persistenceOptions), created: false }
    : persistClawInstallRecordWithDisposition(plan, persistenceOptions);
}

export function markInstallStatus(
  agentId: string,
  status: ClawInstallStatus,
  expectedStatuses: ClawInstallStatus[],
  options: ClawAddApplyOptions,
  agentClaimed?: boolean,
  agentOrigin?: ClawAgentOrigin,
): void {
  assertApplyLeaseOwned(options);
  (options.updateRecord ?? updateClawInstallRecordStatus)(agentId, status, {
    ...options,
    expectedStatuses,
    ...(agentClaimed === undefined ? {} : { agentClaimed }),
    ...(agentOrigin === undefined ? {} : { agentOrigin }),
  });
}

export function persistCommittedLegacyResume(params: {
  plan: ClawAddPlan;
  resumePlan: ClawAddPlan;
  installRecord: PersistedClawInstall;
  persistRecord: typeof persistClawInstallRecord;
  options: ClawAddApplyOptions;
}): PersistedClawInstall {
  const configCommittedAtMs = params.options.nowMs ?? Date.now();
  markInstallStatus(
    params.plan.agent.finalId,
    "config_committed",
    ["workspace_ready", "config_committed"],
    {
      ...params.options,
      nowMs: configCommittedAtMs,
    },
  );
  const committedRecord = {
    ...params.installRecord,
    status: "config_committed" as const,
    updatedAtMs: configCommittedAtMs,
  };
  return params.persistRecord(params.plan, {
    ...params.options,
    status: "config_committed",
    expectedExistingRecord: committedRecord,
    expectedExistingPlan: params.resumePlan,
  });
}

export function isUnclaimedCollision(
  error: ClawAddMutationError,
  configCommitted: boolean,
  installRecord: PersistedClawInstall,
): boolean {
  return (
    error.code === "agent_id_collision" &&
    !configCommitted &&
    installRecord.agentOrigin === "created"
  );
}

function clearUnownedInstallRecord(
  agentId: string,
  expectedStatuses: ClawInstallStatus[],
  options: ClawAddApplyOptions,
): void {
  assertApplyLeaseOwned(options);
  (options.deleteRecord ?? deleteClawInstallRecord)(agentId, {
    ...options,
    expectedStatuses,
  });
}

export function clearFreshUnownedInstallRecord(
  agentId: string,
  installRecordCreated: boolean,
  options: ClawAddApplyOptions,
): void {
  if (installRecordCreated) {
    clearUnownedInstallRecord(agentId, ["pending", "partial"], options);
  }
}

export async function lstatWorkspaceIfPresent(
  workspace: string,
  inspectWorkspace: (path: string) => Promise<Stats>,
): Promise<Stats | undefined> {
  try {
    return await inspectWorkspace(workspace);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function inspectWorkspaceForApply(params: {
  workspace: string;
  agentId: string;
  installRecordCreated: boolean;
  inspectWorkspace: (path: string) => Promise<Stats>;
  options: ClawAddApplyOptions;
  adoptable?: boolean;
}): Promise<Stats | undefined> {
  try {
    assertWorkspacePathUnchanged(params.workspace);
    return await lstatWorkspaceIfPresent(params.workspace, params.inspectWorkspace);
  } catch (error) {
    clearFreshUnownedInstallRecord(params.agentId, params.installRecordCreated, params.options);
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not inspect ${params.adoptable ? "adoptable " : ""}workspace ${JSON.stringify(params.workspace)}: ${coerceErrorMessage(error)}`,
    );
  }
}

export function preserveUnverifiedCreatedWorkspace(params: {
  plan: ClawAddPlan;
  installRecord: PersistedClawInstall;
  packages: PersistedClawPackageRef[];
  error: unknown;
  options: ClawAddApplyOptions;
}): ClawAddResult {
  markInstallStatus(params.plan.agent.finalId, "partial", ["pending", "partial"], params.options);
  return partialResult({
    plan: params.plan,
    installRecord: params.installRecord,
    workspaceCreated: true,
    configCommitted: false,
    packages: params.packages,
    installStatus: "partial",
    error: {
      code: "workspace_parent_failed",
      message: `Could not verify new workspace ${JSON.stringify(params.plan.agent.workspace)}: ${coerceErrorMessage(params.error)}`,
    },
    nowMs: params.options.nowMs,
  });
}

function workspacePathKey(value: string): string {
  return process.platform === "win32" ? normalizeWindowsPathForComparison(value) : value;
}

export function assertWorkspacePathUnchanged(workspace: string): void {
  const canonicalWorkspace = resolvePathViaExistingAncestorSync(workspace);
  if (workspacePathKey(canonicalWorkspace) !== workspacePathKey(workspace)) {
    throw new ClawAddMutationError(
      "workspace_path_changed",
      `Workspace ancestry changed after planning: expected ${JSON.stringify(workspace)}, resolved ${JSON.stringify(canonicalWorkspace)}.`,
    );
  }
}

import type { PersistedClawCronRef } from "./cron.js";
import type { ClawManagedFileStatus, RemovedWorkspaceFile } from "./lifecycle-delete-support.js";
import type { ClawPackageInspection, ClawPackageRemovalResult } from "./package-remove.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { CLAW_OUTPUT_STABILITY } from "./types.js";

export const CLAW_STATUS_SCHEMA_VERSION = "openclaw.clawStatus.v1" as const;
export const CLAW_REMOVE_PLAN_SCHEMA_VERSION = "openclaw.clawRemovePlan.v1" as const;
export const CLAW_REMOVE_RESULT_SCHEMA_VERSION = "openclaw.clawRemoveResult.v1" as const;

export type ClawStatusRecord = {
  install: PersistedClawInstall;
  orphaned?: boolean;
  agentState: "present" | "modified" | "missing";
  workspaceFiles: ClawManagedFileStatus[];
  packages: ClawPackageInspection[];
  cronJobs: PersistedClawCronRef[];
};

export type ClawStatusResult = {
  schemaVersion: typeof CLAW_STATUS_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  target?: string;
  records: ClawStatusRecord[];
  summary: {
    claws: number;
    partial: number;
    missingAgents: number;
    driftedFiles: number;
    packageRefs: number;
    missingPackages: number;
    driftedPackages: number;
    incompletePackages: number;
    cronRefs: number;
    unresolvedCronRefs: number;
  };
};

export type ClawRemovePlanAction = {
  kind:
    | "agent"
    | "configBinding"
    | "agentAllow"
    | "workspace"
    | "agentState"
    | "sessionIndex"
    | "sessionTranscripts"
    | "scheduledJob"
    | "workspaceFile"
    | "packageRef"
    | "cronJob"
    | "installRecord";
  id: string;
  action: "remove" | "delete" | "retain" | "release" | "uninstall" | "trash";
  target: string;
  blocked: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type ClawRemovePlan = {
  schemaVersion: typeof CLAW_REMOVE_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  target: string;
  agentId?: string;
  actions: ClawRemovePlanAction[];
  blockers: Array<{ code: string; message: string }>;
};

export type RemovedCronJob = {
  manifestId: string;
  schedulerJobId?: string;
  action: "removed" | "error";
  message?: string;
};

export type ClawRemoveResult = {
  schemaVersion: typeof CLAW_REMOVE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  status: "complete" | "partial";
  agentId: string;
  agentRemoved: boolean;
  workspaceFiles: RemovedWorkspaceFile[];
  packages: ClawPackageRemovalResult[];
  cronJobs: RemovedCronJob[];
  packageRefsReleased: number;
  error?: { code: string; message: string };
};

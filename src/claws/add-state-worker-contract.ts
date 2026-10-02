import type { WorkspaceSetupState } from "../agents/workspace-state-store.js";
import type { AgentCreatedVia } from "../state/agent-provenance.types.js";
import type { PersistedClawCronRef } from "./cron.js";
import type { PersistedClawMcpServerRef } from "./mcp.js";
import type {
  ClawPackageOrigin,
  ClawPackageRefStatus,
  ClawPackageRelationship,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import type { ClawInstallStatus, PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan, ClawCronJob, ClawMcpServer, ResolvedClawPackage } from "./types.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

export type ClawAddStateWorkerOperations = {
  "claws.add.persistInstall": {
    input: {
      plan: ClawAddPlan;
      status?: ClawInstallStatus;
      nowMs?: number;
      expectedExistingRecord?: PersistedClawInstall;
      expectedExistingPlan?: ClawAddPlan;
      deferLegacyPlanUpgrade?: boolean;
    };
    output: PersistedClawInstall;
  };
  "claws.add.updateInstallStatus": {
    input: {
      agentId: string;
      status: ClawInstallStatus;
      nowMs?: number;
      expectedStatuses?: ClawInstallStatus[];
    };
    output: void;
  };
  "claws.add.deleteInstall": {
    input: { agentId: string; expectedStatuses?: ClawInstallStatus[] };
    output: void;
  };
  "claws.add.recordAgentProvenance": {
    input: {
      agentId: string;
      provenance: { createdVia: AgentCreatedVia; creatorAgentId?: string };
      nowMs?: number;
    };
    output: void;
  };
  "claws.add.persistPackageRef": {
    input: {
      plan: ClawAddPlan;
      pkg: ResolvedClawPackage;
      nowMs?: number;
      status?: ClawPackageRefStatus;
      relationship?: ClawPackageRelationship;
      origin?: ClawPackageOrigin;
      independentOwner?: boolean;
    };
    output: PersistedClawPackageRef;
  };
  "claws.add.updatePackageRefStatus": {
    input: {
      ref: PersistedClawPackageRef;
      status: ClawPackageRefStatus;
      nowMs?: number;
    };
    output: PersistedClawPackageRef;
  };
  "claws.add.persistWorkspaceFile": {
    input: { record: PersistedClawWorkspaceFile };
    output: void;
  };
  "claws.add.updateWorkspaceFileStatus": {
    input: {
      record: PersistedClawWorkspaceFile;
      expectedStatuses: PersistedClawWorkspaceFile["status"][];
    };
    output: void;
  };
  "claws.add.persistMcpPendingRef": {
    input: {
      plan: ClawAddPlan;
      name: string;
      server: ClawMcpServer;
      ownership: Pick<PersistedClawMcpServerRef, "relationship" | "origin" | "independentOwner">;
      nowMs?: number;
    };
    output: PersistedClawMcpServerRef;
  };
  "claws.add.updateMcpRef": {
    input: {
      ref: PersistedClawMcpServerRef;
      update: { status: PersistedClawMcpServerRef["status"]; error?: string };
      nowMs?: number;
    };
    output: PersistedClawMcpServerRef;
  };
  "claws.add.persistCronPendingRef": {
    input: { plan: ClawAddPlan; job: ClawCronJob; nowMs?: number };
    output: PersistedClawCronRef;
  };
  "claws.add.updateCronRef": {
    input: {
      ref: PersistedClawCronRef;
      update: {
        schedulerJobId?: string;
        status: PersistedClawCronRef["status"];
        error?: string;
      };
      nowMs?: number;
    };
    output: PersistedClawCronRef;
  };
  "claws.add.mergeBootstrapSetupState": {
    input: { workspaceDir: string; bootstrapSeededAt: string; nowMs: number };
    output: WorkspaceSetupState;
  };
};

export type ClawAddStateCommand = {
  [K in keyof ClawAddStateWorkerOperations]: {
    type: K;
    input: ClawAddStateWorkerOperations[K]["input"];
  };
}[keyof ClawAddStateWorkerOperations];

const clawAddStateCommands = {
  "claws.add.persistInstall": true,
  "claws.add.updateInstallStatus": true,
  "claws.add.deleteInstall": true,
  "claws.add.recordAgentProvenance": true,
  "claws.add.persistPackageRef": true,
  "claws.add.updatePackageRefStatus": true,
  "claws.add.persistWorkspaceFile": true,
  "claws.add.updateWorkspaceFileStatus": true,
  "claws.add.persistMcpPendingRef": true,
  "claws.add.updateMcpRef": true,
  "claws.add.persistCronPendingRef": true,
  "claws.add.updateCronRef": true,
  "claws.add.mergeBootstrapSetupState": true,
} as const;

export function isClawAddStateCommand(command: { type: string }): command is ClawAddStateCommand {
  return Object.hasOwn(clawAddStateCommands, command.type);
}

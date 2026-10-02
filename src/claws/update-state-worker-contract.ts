import type { PersistedClawCronRef } from "./cron.js";
import type { PersistedClawMcpServerRef } from "./mcp.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import type { ClawInstallStatus, PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

export type ClawUpdateStateWorkerOperations = {
  "claws.update.replacePackageRef": {
    input: {
      expected?: PersistedClawPackageRef;
      replacement?: PersistedClawPackageRef;
    };
    output: void;
  };
  "claws.update.upsertWorkspaceFile": {
    input: { record: PersistedClawWorkspaceFile };
    output: void;
  };
  "claws.update.deleteWorkspaceFile": {
    input: { agentId: string; path: string };
    output: void;
  };
  "claws.update.upsertMcpRef": {
    input: { record: PersistedClawMcpServerRef };
    output: void;
  };
  "claws.update.deleteMcpRef": {
    input: { agentId: string; name: string };
    output: void;
  };
  "claws.update.upsertCronRef": {
    input: { record: PersistedClawCronRef };
    output: void;
  };
  "claws.update.deleteCronRef": {
    input: { agentId: string; manifestId: string };
    output: void;
  };
  "claws.update.persistInstall": {
    input: {
      plan: ClawAddPlan;
      nowMs?: number;
      expectedClaw?: { version: string; integrity: string };
      status?: ClawInstallStatus;
    };
    output: PersistedClawInstall;
  };
};

export type ClawUpdateStateCommand = {
  [K in keyof ClawUpdateStateWorkerOperations]: {
    type: K;
    input: ClawUpdateStateWorkerOperations[K]["input"];
  };
}[keyof ClawUpdateStateWorkerOperations];

const clawUpdateStateCommands = {
  "claws.update.replacePackageRef": true,
  "claws.update.upsertWorkspaceFile": true,
  "claws.update.deleteWorkspaceFile": true,
  "claws.update.upsertMcpRef": true,
  "claws.update.deleteMcpRef": true,
  "claws.update.upsertCronRef": true,
  "claws.update.deleteCronRef": true,
  "claws.update.persistInstall": true,
} as const;

export function isClawUpdateStateCommand(command: {
  type: string;
}): command is ClawUpdateStateCommand {
  return Object.hasOwn(clawUpdateStateCommands, command.type);
}

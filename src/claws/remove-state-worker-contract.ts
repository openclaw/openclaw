import type { ClawPackageLifecycleLeaseIdentity } from "../state/claw-package-lifecycle-lease.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";
import type { ClawRemoveFacts } from "./remove-facts.kernel.js";

export type ClawRemoveStateWorkerOperations = {
  "claws.remove.packageRefStatus": {
    input: {
      agentId: string;
      operationId: string;
      expectedInstallDigest: string;
      packageLease: ClawPackageLifecycleLeaseIdentity;
      expectedRef: PersistedClawPackageRef;
      expectedArtifactRefs: PersistedClawPackageRef[];
      status: PersistedClawPackageRef["status"];
    };
    output: PersistedClawPackageRef;
  };
  "claws.monitors.assertNoAgentLeases": {
    input: { agentId: string; operationId: string };
    output: void;
  };
  "claws.monitors.quiesce": {
    input: {
      agentId: string;
      operationId: string;
      expectedInstall: PersistedClawInstall | null;
      expectedAttachedJobs: ClawRemoveFacts["attachedJobs"];
      expectedCronRefs: ClawRemoveFacts["cronRefs"];
    };
    output: void;
  };
  "claws.monitors.prepareDatabaseClose": {
    input: {
      agentId: string;
      operationId: string;
      expectedInstall: PersistedClawInstall | null;
      databasePath: string;
    };
    output: void;
  };
};

export type ClawRemoveStateCommand = {
  [K in keyof ClawRemoveStateWorkerOperations]: {
    type: K;
    input: ClawRemoveStateWorkerOperations[K]["input"];
  };
}[keyof ClawRemoveStateWorkerOperations];

const clawRemoveStateCommands = {
  "claws.remove.packageRefStatus": true,
  "claws.monitors.assertNoAgentLeases": true,
  "claws.monitors.quiesce": true,
  "claws.monitors.prepareDatabaseClose": true,
} as const;

export function isClawRemoveStateCommand(command: {
  type: string;
}): command is ClawRemoveStateCommand {
  return Object.hasOwn(clawRemoveStateCommands, command.type);
}

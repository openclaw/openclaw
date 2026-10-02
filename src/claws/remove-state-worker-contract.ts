import type { AgentDeletionJournalEntry } from "../state/agent-deletion-journal.js";
import type { ClawPackageLifecycleLeaseIdentity } from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateLeaseOwnerIdentity } from "../state/openclaw-state-lease-storage.js";
import type { RemovedWorkspaceFile } from "./lifecycle-delete-support.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";
import type { ClawRemoveFacts } from "./remove-facts.kernel.js";

export type ClawRemoveStateGuard = {
  agentId: string;
  operationId: string;
  lease: OpenClawStateLeaseOwnerIdentity;
  expectedInstall: PersistedClawInstall | null;
};

export type ClawRemoveStateWorkerOperations = {
  "claws.remove.claim": {
    input: ClawRemoveStateGuard & {
      workspaceDir: string;
      agentDir: string;
      sessionsDir: string;
    };
    output: {
      existingJournal: boolean;
      journal: AgentDeletionJournalEntry;
    };
  };
  "claws.remove.assert": {
    input: ClawRemoveStateGuard;
    output: void;
  };
  "claws.remove.rollback": {
    input: ClawRemoveStateGuard;
    output: void;
  };
  "claws.remove.releaseRows": {
    input: ClawRemoveStateGuard & {
      files: RemovedWorkspaceFile[];
      cleanupErrors: string[];
    };
    output: { complete: boolean; cleanupErrors: string[] };
  };
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
  "claws.remove.claim": true,
  "claws.remove.assert": true,
  "claws.remove.rollback": true,
  "claws.remove.releaseRows": true,
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

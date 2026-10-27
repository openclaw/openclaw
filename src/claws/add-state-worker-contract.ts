import type { WorkspaceSetupState } from "../agents/workspace-state-types.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";

export type ClawAddStateWorkerOperations = {
  "claws.add.mergeBootstrapSetupState": {
    input: {
      workspaceDir: string;
      bootstrapSeededAt: string;
      nowMs: number;
      /** Leases the Gateway Add owner holds; the write commits only while all remain owned. */
      leases?: readonly OpenClawStateLeaseIdentity[];
    };
    output: WorkspaceSetupState;
  };
};

export type ClawAddStateCommand = {
  type: "claws.add.mergeBootstrapSetupState";
  input: ClawAddStateWorkerOperations["claws.add.mergeBootstrapSetupState"]["input"];
};

export function isClawAddStateCommand(command: { type: string }): command is ClawAddStateCommand {
  return command.type === "claws.add.mergeBootstrapSetupState";
}

import type { WorkspaceSetupState } from "../agents/workspace-state-store.kernel.js";

export type ClawAddStateWorkerOperations = {
  "claws.add.mergeBootstrapSetupState": {
    input: { workspaceDir: string; bootstrapSeededAt: string; nowMs: number };
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

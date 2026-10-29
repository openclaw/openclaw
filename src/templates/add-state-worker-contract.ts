import type { WorkspaceSetupState } from "../agents/workspace-state-types.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";

export type TemplateAddStateWorkerOperations = {
  "templates.add.mergeBootstrapSetupState": {
    input: {
      workspaceDir: string;
      bootstrapSeededAt: string;
      nowMs: number;
      leases?: readonly OpenClawStateLeaseIdentity[];
    };
    output: WorkspaceSetupState;
  };
};

export type TemplateAddStateCommand = {
  type: "templates.add.mergeBootstrapSetupState";
  input: TemplateAddStateWorkerOperations["templates.add.mergeBootstrapSetupState"]["input"];
};

export function isTemplateAddStateCommand(command: {
  type: string;
}): command is TemplateAddStateCommand {
  return command.type === "templates.add.mergeBootstrapSetupState";
}

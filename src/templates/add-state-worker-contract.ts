import type { WorkspaceSetupState } from "../agents/workspace-state-types.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";

export type TemplateAddStateWorkerOperations = {
  "templates.add.mergeBootstrapSetupState": {
    input: {
      workspaceDir: string;
      bootstrapSeededAt: string;
      bootstrapSha256: string;
      nowMs: number;
      leases?: readonly OpenClawStateLeaseIdentity[];
    };
    output: WorkspaceSetupState;
  };
  "templates.add.rollbackBootstrapSeed": {
    input: {
      workspaceDir: string;
      bootstrapSeededAt: string;
      leases?: readonly OpenClawStateLeaseIdentity[];
    };
    output: void;
  };
};

export type TemplateAddStateCommand = {
  [Key in keyof TemplateAddStateWorkerOperations]: {
    type: Key;
    input: TemplateAddStateWorkerOperations[Key]["input"];
  };
}[keyof TemplateAddStateWorkerOperations];

export function isTemplateAddStateCommand(command: {
  type: string;
}): command is TemplateAddStateCommand {
  return (
    command.type === "templates.add.mergeBootstrapSetupState" ||
    command.type === "templates.add.rollbackBootstrapSeed"
  );
}

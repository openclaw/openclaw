import type {
  WorkspaceSetupState,
  WorkspaceStateSnapshot,
} from "./workspace-state-store.kernel.js";

export type WorkspaceStateWorkerOperations = {
  "workspace.snapshotAndRegister": {
    input: { workspaceDir: string };
    output: WorkspaceStateSnapshot;
  };
  "workspace.mergeSetup": {
    input: {
      workspaceDir: string;
      next: Partial<Omit<WorkspaceSetupState, "version">>;
      nowMs: number;
    };
    output: WorkspaceSetupState;
  };
  "workspace.expire": { input: { workspaceDir: string; nowMs: number }; output: string | false };
};

export type WorkspaceStateWorkerCommand = {
  [K in keyof WorkspaceStateWorkerOperations]: {
    type: K;
    input: WorkspaceStateWorkerOperations[K]["input"];
  };
}[keyof WorkspaceStateWorkerOperations];

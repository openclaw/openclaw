import type { AgentDeletionRecoveryHoldPredicate } from "../state/agent-deletion-journal-recovery.kernel.js";
import type {
  WorkspaceSetupState,
  WorkspaceStateSnapshot,
} from "./workspace-state-store.kernel.js";

export type WorkspaceStateGuard = {
  /** Host lifecycle and filesystem authority only; never reads SQLite. */
  assertHost?: () => void;
  recoveryHoldPredicate?: AgentDeletionRecoveryHoldPredicate;
  /** Released SDK compatibility: before worker dispatch or host file mutation, never a grant. */
  beforeLegacyApply?: () => void;
};

type WorkspaceStateInput = {
  workspaceDir: string;
  recoveryHoldPredicate?: AgentDeletionRecoveryHoldPredicate;
};

export type WorkspaceStateWorkerOperations = {
  "workspace.snapshotAndRegister": {
    input: WorkspaceStateInput;
    output: WorkspaceStateSnapshot;
  };
  "workspace.mergeSetup": {
    input: WorkspaceStateInput & {
      next: Partial<Omit<WorkspaceSetupState, "version">>;
      nowMs: number;
    };
    output: WorkspaceSetupState;
  };
  "workspace.expire": { input: WorkspaceStateInput & { nowMs: number }; output: string | false };
};

export type WorkspaceStateWorkerCommand = {
  [K in keyof WorkspaceStateWorkerOperations]: {
    type: K;
    input: WorkspaceStateWorkerOperations[K]["input"];
  };
}[keyof WorkspaceStateWorkerOperations];

import type { AgentDeletionRecoveryHoldPredicate } from "../state/agent-deletion-journal-recovery.kernel.js";
import type { AgentDeletionWorkerGuard } from "../state/agent-deletion-worker-contract.js";
import type { WorkspaceStateIdentity } from "./workspace-state-identity.js";
import type { WorkspaceAttestationInput } from "./workspace-state-store.kernel.js";
import type {
  WorkspaceAttestation,
  WorkspaceSetupState,
  WorkspaceStateSnapshot,
} from "./workspace-state-types.js";

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

export type WorkspaceStateDeletionPlan = {
  cacheRoot: string;
  lexicalAlias: WorkspaceStateIdentity;
  currentCanonicalIdentity: WorkspaceStateIdentity;
  pathEntryExisted: boolean;
};

export type WorkspaceStateDeletionReceipt = {
  kind: "workspace-deleted";
  workspacePath: string;
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
  "workspace.replaceAttestation": {
    input: WorkspaceStateInput & WorkspaceAttestationInput;
    output: WorkspaceAttestation;
  };
  "workspace.delete": {
    input: { plan: WorkspaceStateDeletionPlan; deletion?: AgentDeletionWorkerGuard };
    output: WorkspaceStateDeletionReceipt;
  };
};

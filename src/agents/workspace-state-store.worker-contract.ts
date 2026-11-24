import type { AgentDeletionRecoveryHoldPredicate } from "../state/agent-deletion-journal-recovery.kernel.js";
import type { AgentDeletionWorkerGuard } from "../state/agent-deletion-worker-contract.js";
import type { SandboxStateOwnerPath } from "./sandbox/state-owner-path.js";
import type { WorkspaceFilesystemEvidence } from "./workspace-state-guard.js";
import type { WorkspaceStateIdentity } from "./workspace-state-identity.js";
import type { WorkspaceAttestationInput } from "./workspace-state-store.kernel.js";
import type {
  WorkspaceAttestation,
  WorkspaceSetupState,
  WorkspaceStateSnapshot,
} from "./workspace-state-types.js";

export type WorkspaceStateGuard = {
  /** Live host lifecycle authority; physical evidence is checked by the effect owner. */
  assertHost?: () => void;
  /** Host-native effect owners prepare physical state before the final live grant. */
  prepareHost?: () => Promise<void>;
  filesystem?: readonly WorkspaceFilesystemEvidence[];
  stateOwnerPath?: SandboxStateOwnerPath;
  recoveryHoldPredicate?: AgentDeletionRecoveryHoldPredicate;
  /** Released SDK compatibility: before worker dispatch or host file mutation, never a grant. */
  beforeLegacyApply?: () => void;
};

type WorkspaceStateInput = {
  workspaceDir: string;
  recoveryHoldPredicate?: AgentDeletionRecoveryHoldPredicate;
  filesystem?: readonly WorkspaceFilesystemEvidence[];
  stateOwnerPath?: SandboxStateOwnerPath;
};

export type WorkspaceStateDeletionPlan = {
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
  "workspace.rollbackBootstrapSeed": {
    input: WorkspaceStateInput & { bootstrapSeededAt: string };
    output: void;
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

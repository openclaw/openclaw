import type { SqliteWorkerAdmissionRequest } from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDeletionCleanupWorkerAuthority } from "./agent-deletion-cleanup.types.js";
import type { AgentDeletionWorkerGuard } from "./agent-deletion-worker-contract.js";
import type {
  OpenClawStateAsyncLeaseContext,
  OpenClawStateWorkerLeaseContext,
} from "./openclaw-state-lease-context.js";
import type { withOpenClawStateLeaseAsync } from "./openclaw-state-lease.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";
import type { DomainScope } from "./openclaw-state-worker-store.types.js";

export type AgentDeletionWorkerAuthority = AgentDeletionCleanupWorkerAuthority & {
  withStateLease<T>(
    options: Parameters<typeof withOpenClawStateLeaseAsync>[0],
    run: (
      lease: OpenClawStateAsyncLeaseContext,
      assertCurrentHost: () => void,
      assertCurrentFinal: () => void,
    ) => Promise<T>,
  ): Promise<T>;
  runWithWorker<T>(
    operation: (
      scope: DomainScope,
      guard: AgentDeletionWorkerGuard,
      additionalLeaseIdentities: readonly OpenClawStateLeaseIdentity[],
    ) => Promise<T>,
    options?: {
      assertCurrent?: () => void;
      onCommitted?: (facts: unknown) => void;
      onAdmission?: (request: SqliteWorkerAdmissionRequest, stateIdentityKey: string) => void;
      additionalLeases?: readonly OpenClawStateWorkerLeaseContext[];
    },
  ): Promise<T>;
};

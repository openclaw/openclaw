import type { AgentDeletionWorkerGuard } from "./agent-deletion-worker-contract.js";
import type { WorkerLeaseScope } from "./openclaw-state-lease-worker-owner.js";

/** Cleanup borrows the deletion lease without depending on the shared worker command catalog. */
export type AgentDeletionCleanupWorkerAuthority = {
  assertCurrentHost(this: void): void;
  runWithLeaseAdmission<T>(
    operation: (scope: WorkerLeaseScope, guard: AgentDeletionWorkerGuard) => Promise<T>,
  ): Promise<T>;
};

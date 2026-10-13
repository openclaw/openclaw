import type { PersistedClawInstall } from "../claws/provenance-types.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";

/** Comparison inputs only; the original live lease owner admits every use. */
export type AgentDeletionWorkerPredicate = {
  agentId: string;
  operationId: string;
  expectedClawInstall?: PersistedClawInstall | null;
};

export type AgentDeletionWorkerGuard = {
  lease: OpenClawStateLeaseIdentity;
  predicate: AgentDeletionWorkerPredicate;
};

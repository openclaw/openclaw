import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { OpenClawStateWorkerLeaseContext } from "../state/openclaw-state-lease-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

export type TemplateMutationStateOptions = OpenClawStateDatabaseOptions & {
  stateMode?: "worker";
  assertCurrent?: () => void;
  prepareEffect?: () => Promise<void>;
  leaseSet?: {
    context: OpenClawStateWorkerContext;
    leases: readonly OpenClawStateWorkerLeaseContext[];
  };
};

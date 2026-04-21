import type {
  DurableJobRecord,
  DurableJobTransitionRecord,
} from "./durable-job-registry.types.js";

export type DurableJobRegistryStoreSnapshot = {
  jobs: Map<string, DurableJobRecord>;
  transitionsByJobId: Map<string, DurableJobTransitionRecord[]>;
};

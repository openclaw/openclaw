import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";

export type ClawMutationStateOptions = OpenClawStateDatabaseOptions & {
  stateMode?: "worker";
  assertCurrent?: () => void;
  prepareEffect?: () => Promise<void>;
};

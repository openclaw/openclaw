import { AsyncLocalStorage } from "node:async_hooks";

/** The lifecycle caller owns this monotonic deadline; adapters may not renew it. */
export type ProcessCleanupBudget = {
  deadline: number;
  warn: (message: string) => void;
};

const cleanupBudget = new AsyncLocalStorage<ProcessCleanupBudget>();

export function getProcessCleanupBudget(): ProcessCleanupBudget | undefined {
  return cleanupBudget.getStore();
}

export function runWithProcessCleanupBudget<T>(
  budget: ProcessCleanupBudget | undefined,
  run: () => T,
): T {
  return budget ? cleanupBudget.run(budget, run) : run();
}

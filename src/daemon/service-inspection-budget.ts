import { AsyncLocalStorage } from "node:async_hooks";

/** Manager deadlines exclude only synchronous caller custody/admission checks.
 * The context carries accounting, never authority: every guard still runs, and
 * native I/O, async waits, cleanup, and unrelated inspections keep their clocks.
 */
export type ServiceInspectionBudget = {
  now: () => number;
  run: <T>(operation: () => T) => T;
  guard: (assertCurrent: () => void) => void;
};

const budgets = new AsyncLocalStorage<ServiceInspectionBudget>();

function createServiceInspectionBudget(): ServiceInspectionBudget {
  const now = () => performance.now();
  let excluded = 0;
  let checkingSince: number | undefined;
  const budget: ServiceInspectionBudget = {
    now: () => (checkingSince ?? now()) - excluded,
    run: (operation) => budgets.run(budget, operation),
    guard(assertCurrent) {
      if (checkingSince !== undefined) {
        assertCurrent();
        return;
      }
      const started = now();
      checkingSince = started;
      try {
        assertCurrent();
      } finally {
        excluded += now() - started;
        checkingSince = undefined;
      }
    },
  };
  return budget;
}

/** Nested inspectors share accounting; independent calls have independent clocks. */
export function withServiceInspectionBudget<T>(
  operation: (budget: ServiceInspectionBudget) => T,
): T {
  const budget = budgets.getStore() ?? createServiceInspectionBudget();
  return budget.run(() => operation(budget));
}

/** Capture at submission, not at connection admission: peers outlive one read. */
export function getServiceInspectionClock(
  fallback: () => number = () => performance.now(),
): () => number {
  return budgets.getStore()?.now ?? fallback;
}

export function runServiceInspectionGuard(assertCurrent: (() => void) | undefined): void {
  if (!assertCurrent) {
    return;
  }
  const budget = budgets.getStore();
  if (budget) {
    budget.guard(assertCurrent);
  } else {
    assertCurrent();
  }
}

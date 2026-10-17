import { resolveSqliteInspectionBudget } from "./sqlite-readonly-worker.js";
import type { UpdateSnapshotCapacity } from "./update-snapshot-capacity-schema.js";

/** An update deadline replaces the size-scaled allowance; a shorter deadline is reported. */
export function resolveUpdateCanaryBudget(
  stateDir: string,
  capacity: Pick<UpdateSnapshotCapacity, "sqliteBytes" | "pluginBytes">,
  timeoutMs: number | undefined,
): { budget: number; warnings: string[] } {
  // Each fresh process may inspect the private state again, including the Gateway.
  const automatic = resolveSqliteInspectionBudget(
    "update validation",
    stateDir,
    capacity.sqliteBytes + (capacity.pluginBytes ?? 0),
  ).timeoutMs;
  const budget = Math.max(1, timeoutMs ?? automatic);
  return {
    budget,
    // Gateway handoffs pass their default step deadline as --timeout, so the
    // operator may not have set this deadline.
    warnings:
      budget < automatic
        ? [
            `The update deadline limits each update check to ${Math.ceil(budget / 1000)} s, below the automatic ${Math.ceil(automatic / 1000)} s allowance for this state. If a check runs out of time, retry with a longer --timeout.`,
          ]
        : [],
  };
}

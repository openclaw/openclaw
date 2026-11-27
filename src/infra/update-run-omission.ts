import type { UpdateRunStep } from "./update-run-record.js";

// Keep the array and shipped step schema compatible by recording the count in an ordinary row.
export const UPDATE_RUN_TRUNCATED_STEP = "history:truncated";

export function getUpdateRunOmittedStepCount(steps: readonly UpdateRunStep[]): number {
  const marker = steps.find((step) => step.step === UPDATE_RUN_TRUNCATED_STEP);
  const count = Number(marker?.detail);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function formatUpdateRunOmittedSteps(steps: readonly UpdateRunStep[]): string | undefined {
  const count = getUpdateRunOmittedStepCount(steps);
  return count > 0
    ? `Update history truncated: ${count} ${count === 1 ? "row" : "rows"} omitted.`
    : undefined;
}

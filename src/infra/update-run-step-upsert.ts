import { findEvictableStep, omitUpdateRunStep } from "./update-run-codec.js";
import { UPDATE_RUN_STEP_LIMIT } from "./update-run-limits.js";
import { UPDATE_RUN_TRUNCATED_STEP } from "./update-run-omission.js";
import type { UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";
import { updateRunStepKey } from "./update-run-step-key.js";

/** Kept apart from update-run-step.ts: the codec import must not reach the Control UI bundle. */
export function upsertStep(record: UpdateRunRecord, input: UpdateRunStep): void {
  const step = { ...input, step: updateRunStepKey(input.step) };
  if (step.step === UPDATE_RUN_TRUNCATED_STEP) {
    return;
  }
  const index = record.steps.findIndex((existing) => existing.step === step.step);
  if (index >= 0) {
    record.steps[index] = { ...record.steps[index], ...step };
  } else {
    record.steps.push(step);
  }
  while (record.steps.length > UPDATE_RUN_STEP_LIMIT) {
    const disposable = findEvictableStep(record.steps, true);
    if (disposable < 0) {
      throw new Error("Update run retained steps exceed the step limit");
    }
    omitUpdateRunStep(record.steps, disposable);
  }
}

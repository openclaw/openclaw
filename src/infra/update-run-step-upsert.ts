import { isRetainedStep } from "./update-run-codec.js";
import type { UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";
import { updateRunStepKey } from "./update-run-step-key.js";

/** Kept apart from update-run-step.ts: the codec import must not reach the Control UI bundle. */
export function upsertStep(record: UpdateRunRecord, input: UpdateRunStep): void {
  const step = { ...input, step: updateRunStepKey(input.step) };
  const index = record.steps.findIndex((existing) => existing.step === step.step);
  if (index >= 0) {
    record.steps[index] = { ...record.steps[index], ...step };
  } else {
    record.steps.push(step);
  }
  while (record.steps.length > 128) {
    const disposable = record.steps.findIndex((entry) => !isRetainedStep(entry));
    if (disposable < 0) {
      throw new Error("Update run retained steps exceed the step limit");
    }
    record.steps.splice(disposable, 1);
  }
}

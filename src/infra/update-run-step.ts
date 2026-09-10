import { summarizeUpdateStepFailure, type UpdateRunStep } from "./update-run-record.js";
import type { UpdateStepResult } from "./update-runner-types.js";

type ResultStep = Pick<
  UpdateStepResult,
  "name" | "exitCode" | "advisory" | "warnings" | "termination" | "stdoutTail" | "stderrTail"
>;

/** Warning rows preserve producer-classified advisories in the existing diagnostic ledger. */
export function updateRunStepsFromResultStep(step: ResultStep): UpdateRunStep[] {
  const warnings = step.advisory
    ? step.warnings?.length
      ? step.warnings
      : [step.advisory.message]
    : [];
  return [
    {
      step: step.name,
      status: step.exitCode === 0 || step.advisory ? "completed" : "failed",
      ...(step.exitCode !== 0
        ? { detail: step.advisory?.message ?? summarizeUpdateStepFailure(step) }
        : {}),
    },
    ...warnings.slice(0, 32).map((detail, index) => ({
      step: `warning:${step.name}${index === 0 ? "" : `:${index + 1}`}`,
      status: "completed" as const,
      detail,
    })),
  ];
}

export function updateRunWarningMessages(steps: readonly UpdateRunStep[]): string[] {
  return steps.flatMap((step) =>
    step.status === "completed" && step.step.startsWith("warning:") && step.detail
      ? [step.detail]
      : [],
  );
}

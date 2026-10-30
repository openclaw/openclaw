import { createUpdateErrorFact, type UpdateFailureFact } from "./update-failure-facts.js";
import { isPublicUpdateFailureCode } from "./update-failure-public-codes.js";
import type { UpdateRunResult } from "./update-run-result.js";
import { updateRunStepKey } from "./update-run-step-key.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";

/** Terminal outcomes need facts even when no command ran or its diagnostic is private. */
export function completeUpdateFailureSummary(
  reason: string | null | undefined,
  failureFacts: UpdateFailureFact[] | undefined,
): { reason: string; failureFacts: UpdateFailureFact[] } {
  const code = reason?.trim() ? reason : "update-failed";
  return {
    reason: code,
    failureFacts: failureFacts?.some((fact) => isPublicUpdateFailureCode(fact.code))
      ? failureFacts
      : [
          ...(failureFacts ?? []).slice(0, 4),
          { check: "update", code: isPublicUpdateFailureCode(code) ? code : "update-failed" },
        ],
  };
}

/** Normalize once before a terminal result leaves its owner, including history-free refusals. */
export function normalizeUpdateFailureResult(
  result: UpdateRunResult,
  cause?: unknown,
): UpdateRunResult {
  if (result.status !== "error") {
    return result;
  }
  const failed = result.failedStep ?? result.steps.findLast(isFailedUpdateStep);
  const { reason, failureFacts } = completeUpdateFailureSummary(
    result.reason,
    failed?.failureFacts?.length
      ? failed.failureFacts
      : cause === undefined
        ? undefined
        : [createUpdateErrorFact("update", cause)],
  );
  const failedStep: UpdateStepResult = {
    ...(failed ?? {
      name: "update",
      command: "openclaw update",
      cwd: result.root ?? "",
      durationMs: 0,
      exitCode: null,
    }),
    failureFacts,
  };
  const failedIndex = failed
    ? result.steps.findLastIndex(
        (step) =>
          isFailedUpdateStep(step) && updateRunStepKey(step.name) === updateRunStepKey(failed.name),
      )
    : -1;
  return {
    ...result,
    reason,
    ...(result.failedStep ? { failedStep } : {}),
    steps:
      failedIndex >= 0
        ? result.steps.map((step, index) => (index === failedIndex ? failedStep : step))
        : [...result.steps, failedStep],
  };
}

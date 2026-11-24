import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { UpdateRunRecord } from "./update-run-record.js";

/** Present existing terminal cause facts without exposing unrelated startup output. */
export function prependUpdateRunCause(
  run: Pick<UpdateRunRecord, "status" | "origin" | "steps" | "verification">,
  lines: string[],
): void {
  const refusal =
    run.status === "failed" &&
    run.verification.rollbackOutcome?.reason === "new build refused the configuration (exit 78)"
      ? run.steps.findLast(
          (step) => step.step === "diagnostic:startup" && step.status === "completed",
        )
      : undefined;
  // The serving Gateway redacts the diagnostic before recording it.
  const detail = refusal?.detail || refusal?.stderrTail;
  if (detail) {
    const cause = `Cause detail: ${detail}`;
    lines.unshift(cause.length <= 500 ? cause : `${sliceUtf16Safe(cause, 0, 499)}…`);
  }
  if (run.status !== "succeeded" && run.origin.cause && run.origin.cause !== "unknown") {
    lines.unshift(`Cause: ${run.origin.cause}`);
  }
}

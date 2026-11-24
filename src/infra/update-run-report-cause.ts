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
  const detail = refusal?.stderrTail || refusal?.detail;
  if (detail) {
    const cause = `Cause detail: ${detail}`;
    lines.unshift(
      cause.length <= 500 ? cause : `Cause detail: …${sliceUtf16Safe(detail, detail.length - 485)}`,
    );
  }
  if (run.status !== "succeeded" && run.origin.cause && run.origin.cause !== "unknown") {
    lines.unshift(`Cause: ${run.origin.cause}`);
  }
}

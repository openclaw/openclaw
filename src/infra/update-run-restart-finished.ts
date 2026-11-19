import type { UpdateRunRecord } from "./update-run-record.js";

/** Written by the candidate's shipped-updater restart finisher (update-shipped-restart-finisher). */
export const SHIPPED_RESTART_FINISHER_STEP = "warning:gateway-restart";

/**
 * A shipped updater refused the Gateway restart (`service-revalidation-failed`) and the new
 * package's finisher later refreshed the service and verified the target serving. The stored
 * outcome stays `failed`; readers present the update as completed with that warning.
 */
export function isRefusedRestartFinishedLater(
  run: Pick<UpdateRunRecord, "status" | "reason"> &
    Partial<Pick<UpdateRunRecord, "verification" | "steps" | "after">>,
): boolean {
  const verification = run.verification;
  return (
    run.status === "failed" &&
    run.reason === "service-revalidation-failed" &&
    verification?.serviceRunning === true &&
    verification.versionMatch === true &&
    verification.readyz === true &&
    verification.settled === true &&
    Boolean(verification.runningVersion) &&
    (!run.after?.version || run.after.version === verification.runningVersion) &&
    run.steps?.some(
      (step) => step.step === SHIPPED_RESTART_FINISHER_STEP && step.status === "completed",
    ) === true
  );
}

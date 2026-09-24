import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "./update-doctor-result.js";
import { findActiveUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";

const RETIREMENT_STEP = "finalize:doctor:model-retirement";

function resolveDoctorUpdateRun(env: NodeJS.ProcessEnv) {
  const runId = env[UPDATE_RUN_ID_ENV]?.trim();
  // Published CLI parents omit the run ID but give actual package Doctor this
  // result channel. Candidate rehearsal strips both selectors.
  const run = runId
    ? getUpdateRun(runId, { env })
    : env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim()
      ? findActiveUpdateRun({ env })
      : undefined;
  return run?.status === "running" ? run : undefined;
}

export function hasDeferredUpdateModelRetirement(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    resolveDoctorUpdateRun(env)?.steps.some(
      (step) => step.step === RETIREMENT_STEP && step.status === "skipped",
    ) ?? false
  );
}

/** Completion is published by Doctor only after its repaired config is durable. */
export function recordUpdateModelRetirement(
  status: "deferred" | "completed",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const run = resolveDoctorUpdateRun(env);
  if (
    !run ||
    (status === "completed" &&
      !run.steps.some((step) => step.step === RETIREMENT_STEP && step.status === "skipped"))
  ) {
    return;
  }
  const detail =
    status === "deferred"
      ? "Model retirement repair deferred until plugin convergence."
      : "Deferred model retirement repair completed after plugin convergence.";
  recordUpdateRunStep(
    run.runId,
    {
      step: RETIREMENT_STEP,
      status: status === "deferred" ? "skipped" : "completed",
      endedAtMs: Date.now(),
      detail,
    },
    { env },
  );
  // Completion must follow the package warnings in the bounded status history.
  recordUpdateRunStep(
    run.runId,
    {
      step: `warning:${RETIREMENT_STEP}${status === "deferred" ? ":deferred" : ""}`,
      status: "completed",
      detail,
    },
    { env },
  );
}

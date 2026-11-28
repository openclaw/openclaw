import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "./update-doctor-result.js";
import { findActiveUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const RETIREMENT_STEP = "finalize:doctor:model-retirement";
export const DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING =
  "Model retirement deferred until configured plugin installation converges.";

export function resolveDoctorUpdateRun(
  env: NodeJS.ProcessEnv,
  runId = env[UPDATE_RUN_ID_ENV]?.trim() || undefined,
) {
  // Published CLI parents omit the run ID but give actual package Doctor this
  // result channel. Candidate rehearsal strips both selectors.
  const run =
    runId !== undefined
      ? getUpdateRun(runId, { env })
      : env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim()
        ? findActiveUpdateRun({ env })
        : undefined;
  return run?.status === "running" ? run : undefined;
}

export function hasCompletedUpdateModelRetirement(
  run: Pick<UpdateRunRecord, "steps"> | undefined,
): boolean {
  // Only the selected run's durable completion retires its warning; absence is not success.
  return (
    run?.steps.some((step) => step.step === RETIREMENT_STEP && step.status === "completed") ?? false
  );
}

export function hasDeferredUpdateModelRetirement(
  env: NodeJS.ProcessEnv = process.env,
  runId?: string,
): boolean {
  return (
    resolveDoctorUpdateRun(env, runId)?.steps.some(
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
      ? "Model retirement repair deferred until plugin package convergence: the updating parent still owns plugin installation. Run openclaw update repair after the package update finishes."
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
  // Update the same warning row so durable completion retires the pending warning.
  recordUpdateRunStep(
    run.runId,
    {
      step: `warning:${RETIREMENT_STEP}:deferred`,
      status: status === "deferred" ? "completed" : "skipped",
      detail,
    },
    { env },
  );
}

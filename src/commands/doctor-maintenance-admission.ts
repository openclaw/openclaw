import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { inspectUpdateRepairDriverAdmission } from "../infra/update-run-activity.js";
import { recordUpdateRunRepairContinuation } from "../infra/update-run-ledger.js";
import { createUpdateRunAdmissionReader } from "../infra/update-run-reader.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";

export function resolveDoctorUpdateAdmission(env: NodeJS.ProcessEnv): () => void {
  const inheritedRunId = env[UPDATE_RUN_ID_ENV]?.trim();
  const readRuns = createUpdateRunAdmissionReader(
    { active: true, limit: 100, includeRunId: inheritedRunId },
    { env },
    openDoctorStateSchemaReadAdmission,
  );
  const readAdmission = () => {
    const runs = readRuns();
    const admission = inspectUpdateRepairDriverAdmission(runs, inheritedRunId);
    if (admission.kind === "conflict") {
      throw new Error(admission.message);
    }
    return admission;
  };
  const admission = readAdmission();
  let assertUpdateAdmissionCurrent = () => {
    readAdmission();
  };
  const continuation =
    admission.kind === "continuation"
      ? admission.run
      : admission.runs.find((run) => run.runId === inheritedRunId);
  if (continuation?.steps.some((step) => step.step === "finalize:repair-continuation")) {
    assertUpdateAdmissionCurrent = () => {
      readAdmission();
      recordUpdateRunRepairContinuation(continuation.runId, inheritedRunId, { env });
    };
  }
  return assertUpdateAdmissionCurrent;
}

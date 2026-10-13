import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { inspectUpdateRepairDriverAdmission } from "../infra/update-run-activity.js";
import { recordUpdateRunRepairContinuation } from "../infra/update-run-ledger.js";
import { createUpdateRunAdmissionReader } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";

export function resolveDoctorUpdateAdmission(
  env: NodeJS.ProcessEnv,
  boundRunId?: string,
): {
  assertCurrent: () => void;
  readContinuation: () => UpdateRunRecord | undefined;
  recordContinuation: () => void;
} {
  const inheritedRunId = (boundRunId ?? env[UPDATE_RUN_ID_ENV])?.trim();
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
  const continuation =
    admission.kind === "continuation"
      ? admission.run
      : admission.runs.find((run) => run.runId === inheritedRunId);
  return {
    assertCurrent: () => {
      readAdmission();
    },
    readContinuation: () => {
      const current = readAdmission();
      return current.kind === "continuation" ? current.run : undefined;
    },
    recordContinuation: () => {
      const current = readAdmission();
      if (continuation?.steps.some((step) => step.step === "finalize:repair-continuation")) {
        const run =
          current.kind === "continuation"
            ? current.run
            : current.runs.find((entry) => entry.runId === continuation.runId);
        const step =
          current.kind === "continuation"
            ? "finalize:repair-continuation"
            : "finalize:repair-takeover";
        // Fresh admission still checks authority; an existing receipt needs no
        // writer admission or full integrity scan inside native service deadlines.
        if (run?.steps.some((entry) => entry.step === step)) {
          return;
        }
        recordUpdateRunRepairContinuation(continuation.runId, inheritedRunId, { env });
      }
    },
  };
}

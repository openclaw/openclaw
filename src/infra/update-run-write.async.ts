import { randomUUID } from "node:crypto";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { readUpdateResultPolicy, sendUpdateResultTelemetry } from "./update-result-telemetry.js";
import {
  recordUpdateRunMutationAsync,
  type UpdateRunWriteOptions,
} from "./update-run-mutation.async.js";
import type { UpdateRunPhasePatch } from "./update-run-mutation.types.js";
import type {
  CreateUpdateRunInput,
  FinishUpdateRunInput,
  UpdateRunDiagnostics,
  UpdateRunPhase,
  UpdateRunRecord,
  UpdateRunStep,
} from "./update-run-record.js";
import { hasUpdateRunDiagnostics } from "./update-run-write.js";

export type { UpdateRunWriteOptions } from "./update-run-mutation.async.js";

export function recordUpdateRunStepAsync(
  runId: string,
  step: UpdateRunStep & { reason?: string },
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord | undefined> {
  return recordUpdateRunMutationAsync(
    runId,
    (input) => ({ type: "updateRuns.recordStep", input: { ...input, step } }),
    options,
  ).then((reply) => reply?.record);
}

export async function recordUpdateRunPhaseAsync(
  runId: string,
  phase: UpdateRunPhase,
  patch: UpdateRunPhasePatch = {},
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord> {
  const reply = await recordUpdateRunMutationAsync(
    runId,
    (input) => ({ type: "updateRuns.recordPhase", input: { ...input, phase, patch } }),
    options,
  );
  if (!reply) {
    throw new Error("Required update phase was not recorded");
  }
  return reply.record;
}

export async function createUpdateRunAsync(
  input: CreateUpdateRunInput,
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord> {
  const run = {
    ...input,
    runId: input.runId ?? randomUUID(),
    reportResult: !input.preview && (await readUpdateResultPolicy(options.env)),
  };
  const reply = await recordUpdateRunMutationAsync(
    run.runId,
    (mutation) => ({ type: "updateRuns.create", input: { ...mutation, run } }),
    options,
  );
  if (!reply) {
    throw new Error("Update run was not created");
  }
  return reply.record;
}

export async function finishUpdateRunAsync(
  runId: string,
  result: FinishUpdateRunInput,
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord> {
  const reply = await recordUpdateRunMutationAsync(
    runId,
    (input) => ({ type: "updateRuns.finish", input: { ...input, result } }),
    options,
  );
  if (!reply) {
    throw new Error("Update run outcome was not recorded");
  }
  if (reply.updateResult) {
    void sendUpdateResultTelemetry(reply.updateResult, { env: options.env });
  }
  return reply.record;
}

export async function recordUpdateRunVerificationAsync(
  runId: string,
  verification: UpdateRunRecord["verification"],
  options: UpdateRunWriteOptions & { onlyIfRunning?: true } = {},
): Promise<UpdateRunRecord> {
  const { onlyIfRunning } = options;
  const reply = await recordUpdateRunMutationAsync(
    runId,
    (input) => ({
      type: "updateRuns.recordVerification",
      input: { ...input, verification, onlyIfRunning },
    }),
    options,
  );
  if (!reply) {
    throw new Error("Update verification was not recorded");
  }
  return reply.record;
}

export async function recordUpdateRunDiagnosticsAsync(
  runId: string,
  diagnostics: UpdateRunDiagnostics,
  warn: (message: string) => void,
  options: UpdateRunWriteOptions & { preserveRecovery?: true } = {},
): Promise<UpdateRunRecord | undefined> {
  if (!hasUpdateRunDiagnostics(diagnostics)) {
    return undefined;
  }
  try {
    const { preserveRecovery } = options;
    const reply = await recordUpdateRunMutationAsync(
      runId,
      (input) => ({
        type: "updateRuns.recordDiagnostics",
        input: { ...input, diagnostics, preserveRecovery },
      }),
      options,
    );
    return reply?.record;
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    const fact = createUpdateErrorFact("requested", error, options.env);
    warn(
      `Update diagnostics could not be recorded (${fact.code}): ${fact.message ?? "no error message"}`,
    );
    return undefined;
  }
}

export function createUpdateRunProcessIdentityWarning(
  runId: string | undefined,
  env: NodeJS.ProcessEnv,
): (pid: number, message: string) => void {
  return (pid, message) => {
    console.warn(`[update] ${message}`);
    if (runId) {
      void trackAsyncWork(() =>
        recordUpdateRunStepAsync(
          runId,
          {
            step: `warning:process-start-identity:${pid}`,
            status: "completed",
            detail: message,
            endedAtMs: Date.now(),
          },
          { env },
        ),
      ).catch(() => {
        /* Identity warnings must not abort an update. */
      });
    }
  };
}

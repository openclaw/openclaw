import { randomUUID } from "node:crypto";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { hasSqliteWorkerOutcomeUnknown, isSqliteWorkerError } from "./sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import type { UpdateResultPayload } from "./update-result-payload.js";
import { readUpdateResultPolicy, sendUpdateResultTelemetry } from "./update-result-telemetry.js";
import { captureUpdateRunRedactionFacts, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type {
  UpdateRunPhasePatch,
  UpdateRunWriteCommand,
  UpdateRunWriteInput,
} from "./update-run-mutation.types.js";
import type {
  CreateUpdateRunInput,
  FinishUpdateRunInput,
  UpdateRunDiagnostics,
  UpdateRunPhase,
  UpdateRunRecord,
  UpdateRunStep,
} from "./update-run-record.js";
import { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";
import { hasUpdateRunDiagnostics, isRequiredUpdateRunStep } from "./update-run-write.js";

export type UpdateRunWriteOptions = UpdateRunLedgerOptions & {
  context?: OpenClawStateWorkerContext;
  signal?: AbortSignal;
  /** Live caller custody only; recovery policy is checked in the worker transaction. */
  assertCurrent?: () => void;
  /** Closing admission does not revoke writes that were already accepted. */
  assertAccepting?: () => void;
  retainSettlement?: (settled: Promise<void>) => void;
  requireNoRecovery?: true;
};

/** Capture the receipt before yielding and join its writer through native settlement. */
async function recordUpdateRunMutationAsync(
  runId: string,
  createCommand: (input: UpdateRunWriteInput) => UpdateRunWriteCommand,
  options: UpdateRunWriteOptions = {},
): Promise<{ record: UpdateRunRecord; updateResult?: UpdateResultPayload } | undefined> {
  options.assertAccepting?.();
  if (options.database || options.readOnly) {
    throw new Error("Existing-state writes require their own tracked writable connection.");
  }
  const captured = {
    ...options,
    env: cloneEnvWithPlatformSemantics(options.env ?? process.env),
    ...(options.redactPaths ? { redactPaths: [...options.redactPaths] } : {}),
  };
  const context = captured.context ?? captureOpenClawStateWorkerContext(captured);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    captured.signal?.throwIfAborted();
    captured.assertCurrent?.();
  };
  assertCurrent();
  const command = structuredClone(
    createCommand({
      runId,
      redactionFacts: captureUpdateRunRedactionFacts(captured.env),
      requireNoRecovery: captured.requireNoRecovery,
      busyTimeoutMs: captured.busyTimeoutMs,
      redactPaths: captured.redactPaths,
    }),
  );
  const pending = runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    existingOnly: command.type !== "updateRuns.create",
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
      context.admission.databasePath,
    ]),
  });
  const completion = pending.catch((error: unknown) => {
    if (hasSqliteWorkerOutcomeUnknown(error) && !hasCommandProcessCleanupError(error)) {
      throw new CommandProcessCleanupError({ cause: error });
    }
    if (
      !hasCommandProcessCleanupError(error) &&
      isSqliteWorkerError(error, "overloaded") &&
      command.type === "updateRuns.recordStep" &&
      !isRequiredUpdateRunStep(command.input.step)
    ) {
      // Broker overload certifies non-dispatch; only advisory receipts may be dropped.
      assertCurrent();
      return { kind: "bookkeeping-skipped" as const };
    }
    throw error;
  });
  captured.retainSettlement?.(completion.then(() => undefined));
  const reply = await completion;
  assertCurrent();
  if (!reply) {
    throw new Error("Update history disappeared before recording its outcome");
  }
  if (reply.kind === "recovery-required") {
    throw new UpdateRecoveryRequiredError(reply.recovery);
  }
  if (reply.kind === "bookkeeping-skipped") {
    console.warn(
      "[update] History database is busy or worker admission timed out; bookkeeping was not recorded. The update will continue.",
    );
    return undefined;
  }
  return reply;
}

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

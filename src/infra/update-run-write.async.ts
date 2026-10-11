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
import { hasSqliteWorkerOutcomeUnknown } from "./sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { captureUpdateRunRedactionFacts, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { UpdateRunPhasePatch, UpdateRunWriteCommand } from "./update-run-mutation.types.js";
import type {
  CreateUpdateRunInput,
  FinishUpdateRunInput,
  UpdateRunDiagnostics,
  UpdateRunPhase,
  UpdateRunRecord,
  UpdateRunStep,
} from "./update-run-record.js";
import { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";

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
  mutation:
    | { kind: "step"; step: UpdateRunStep & { reason?: string } }
    | { kind: "phase"; phase: UpdateRunPhase; patch: UpdateRunPhasePatch }
    | { kind: "create"; run: CreateUpdateRunInput }
    | { kind: "finish"; result: FinishUpdateRunInput }
    | { kind: "verification"; verification: UpdateRunRecord["verification"]; onlyIfRunning?: true }
    | { kind: "diagnostics"; diagnostics: UpdateRunDiagnostics; preserveRecovery?: true },
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord | undefined> {
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
  const input = {
    runId,
    redactionFacts: captureUpdateRunRedactionFacts(captured.env),
    requireNoRecovery: captured.requireNoRecovery,
    busyTimeoutMs: captured.busyTimeoutMs,
    redactPaths: captured.redactPaths,
  };
  let command: UpdateRunWriteCommand;
  switch (mutation.kind) {
    case "step":
      command = { type: "updateRuns.recordStep", input: { ...input, step: mutation.step } };
      break;
    case "phase":
      command = {
        type: "updateRuns.recordPhase",
        input: { ...input, phase: mutation.phase, patch: mutation.patch },
      };
      break;
    case "create":
      command = { type: "updateRuns.create", input: { ...input, run: mutation.run } };
      break;
    case "finish":
      command = { type: "updateRuns.finish", input: { ...input, result: mutation.result } };
      break;
    case "verification":
      command = {
        type: "updateRuns.recordVerification",
        input: {
          ...input,
          verification: mutation.verification,
          onlyIfRunning: mutation.onlyIfRunning,
        },
      };
      break;
    case "diagnostics":
      command = {
        type: "updateRuns.recordDiagnostics",
        input: {
          ...input,
          diagnostics: mutation.diagnostics,
          preserveRecovery: mutation.preserveRecovery,
        },
      };
      break;
  }
  command = structuredClone(command);
  const pending = runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    existingOnly: mutation.kind !== "create",
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
      context.admission.databasePath,
    ]),
  });
  const completion = pending.catch((error: unknown) => {
    if (hasSqliteWorkerOutcomeUnknown(error) && !hasCommandProcessCleanupError(error)) {
      throw new CommandProcessCleanupError({ cause: error });
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
      "[update] History database is locked; bookkeeping was not recorded. The update will continue.",
    );
    return undefined;
  }
  return reply.record;
}

export function recordUpdateRunStepAsync(
  runId: string,
  step: UpdateRunStep & { reason?: string },
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord | undefined> {
  return recordUpdateRunMutationAsync(runId, { kind: "step", step }, options);
}

export async function recordUpdateRunPhaseAsync(
  runId: string,
  phase: UpdateRunPhase,
  patch: UpdateRunPhasePatch = {},
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord> {
  const record = await recordUpdateRunMutationAsync(
    runId,
    { kind: "phase", phase, patch },
    options,
  );
  if (!record) {
    throw new Error("Required update phase was not recorded");
  }
  return record;
}

export async function createUpdateRunAsync(
  input: CreateUpdateRunInput,
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord> {
  const run = { ...input, runId: input.runId ?? randomUUID() };
  const record = await recordUpdateRunMutationAsync(run.runId, { kind: "create", run }, options);
  if (!record) {
    throw new Error("Update run was not created");
  }
  return record;
}

export async function finishUpdateRunAsync(
  runId: string,
  result: FinishUpdateRunInput,
  options: UpdateRunWriteOptions = {},
): Promise<UpdateRunRecord> {
  const record = await recordUpdateRunMutationAsync(runId, { kind: "finish", result }, options);
  if (!record) {
    throw new Error("Update run outcome was not recorded");
  }
  return record;
}

export async function recordUpdateRunVerificationAsync(
  runId: string,
  verification: UpdateRunRecord["verification"],
  options: UpdateRunWriteOptions & { onlyIfRunning?: true } = {},
): Promise<UpdateRunRecord> {
  const record = await recordUpdateRunMutationAsync(
    runId,
    { kind: "verification", verification, onlyIfRunning: options.onlyIfRunning },
    options,
  );
  if (!record) {
    throw new Error("Update verification was not recorded");
  }
  return record;
}

export async function recordUpdateRunDiagnosticsAsync(
  runId: string,
  diagnostics: UpdateRunDiagnostics,
  warn: (message: string) => void,
  options: UpdateRunWriteOptions & { preserveRecovery?: true } = {},
): Promise<UpdateRunRecord | undefined> {
  if (
    !(
      diagnostics.failure ||
      diagnostics.recovery ||
      diagnostics.rollbackOutcome ||
      diagnostics.verification
    )
  ) {
    return undefined;
  }
  try {
    return await recordUpdateRunMutationAsync(
      runId,
      { kind: "diagnostics", diagnostics, preserveRecovery: options.preserveRecovery },
      options,
    );
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

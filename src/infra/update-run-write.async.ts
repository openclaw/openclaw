import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { hasSqliteWorkerOutcomeUnknown } from "./sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { captureUpdateRunRedactionFacts, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { UpdateRunPhasePatch, UpdateRunWriteCommand } from "./update-run-mutation.types.js";
import type { UpdateRunPhase, UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";
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
    | { kind: "phase"; phase: UpdateRunPhase; patch: UpdateRunPhasePatch },
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
  const command = structuredClone<UpdateRunWriteCommand>(
    mutation.kind === "step"
      ? { type: "updateRuns.recordStep", input: { ...input, step: mutation.step } }
      : {
          type: "updateRuns.recordPhase",
          input: { ...input, phase: mutation.phase, patch: mutation.patch },
        },
  );
  const pending = runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    existingOnly: true,
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

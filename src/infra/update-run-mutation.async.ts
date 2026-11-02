// Worker mutation admission shared with sealed recovery; outcome policy stays in the facade.
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { hasSqliteWorkerOutcomeUnknown, isSqliteWorkerError } from "./sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import type { UpdateResultPayload } from "./update-result-payload.js";
import { captureUpdateRunRedactionFacts, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { UpdateRunWriteCommand, UpdateRunWriteInput } from "./update-run-mutation.types.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";
import type { PluginCohortRecoveryContinuation } from "./update-run-recovery-types.js";
import {
  assertNoPendingUpdateRecovery,
  assertPluginCohortRecoveryContinuation,
} from "./update-run-recovery.js";
import { isRequiredUpdateRunStep } from "./update-run-write.js";

export type UpdateRunWriteOptions = UpdateRunLedgerOptions & {
  context?: OpenClawStateWorkerContext;
  signal?: AbortSignal;
  /** Live caller custody only; recovery policy is checked in the worker transaction. */
  assertCurrent?: () => void;
  /** Closing admission does not revoke writes that were already accepted. */
  assertAccepting?: () => void;
  retainSettlement?: (settled: Promise<void>) => void;
  requireNoRecovery?: true;
  pluginCohort?: PluginCohortRecoveryContinuation;
};

/** Capture the receipt before yielding and join its writer through native settlement. */
export async function recordUpdateRunMutationAsync(
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
  const continuation = captured.pluginCohort;
  const cohortPair = continuation
    ? assertNoPendingUpdateRecovery({
        env: captured.env,
        path: context.admission.databasePath,
        allowNativeRead: true,
        pluginCohort: continuation,
      })
    : undefined;
  const pluginCohort = cohortPair
    ? {
        runId: cohortPair.cohort.runId,
        transactionId: cohortPair.cohort.transactionId,
        installKey: cohortPair.cohort.installKey,
      }
    : undefined;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    captured.signal?.throwIfAborted();
    captured.assertCurrent?.();
    if (continuation && cohortPair) {
      if (continuation.runId !== runId) {
        throw new Error("Plugin cohort bookkeeping requires its original update run");
      }
      assertPluginCohortRecoveryContinuation(cohortPair, continuation, {
        env: captured.env,
        path: context.admission.databasePath,
      });
    }
  };
  assertCurrent();
  const command = structuredClone(
    createCommand({
      runId,
      redactionFacts: captureUpdateRunRedactionFacts(captured.env),
      requireNoRecovery: captured.requireNoRecovery,
      ...(pluginCohort ? { pluginCohort } : {}),
      busyTimeoutMs: captured.busyTimeoutMs,
      redactPaths: captured.redactPaths,
    }),
  );
  if (
    pluginCohort &&
    (!captured.requireNoRecovery ||
      (command.type !== "updateRuns.recordPhase" &&
        command.type !== "updateRuns.recordStep" &&
        command.type !== "updateRuns.recordDiagnostics"))
  ) {
    throw new Error("Plugin cohort continuation permits only update progress bookkeeping");
  }
  const pending = runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    existingOnly: command.type !== "updateRuns.create",
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(
      assertCurrent,
      [context.admission.databasePath],
      pluginCohort,
    ),
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

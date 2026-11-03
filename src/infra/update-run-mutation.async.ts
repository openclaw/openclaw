// Worker mutation admission shared with sealed recovery; outcome policy stays in the facade.
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { hasSqliteWorkerOutcomeUnknown, isSqliteWorkerError } from "./sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { captureUpdateDoctorSqliteWrite } from "./update-doctor-migration-attribution.js";
import type { PluginCohortRecoveryPair } from "./update-plugin-cohort-schema.js";
import type { UpdateResultPayload } from "./update-result-payload.js";
import { captureUpdateRunRedactionFacts, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { UpdateRunWriteCommand, UpdateRunWriteInput } from "./update-run-mutation.types.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { readUpdateRecoveryAdmissionFactsAsync } from "./update-run-recovery-admission.js";
import { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";
import type { PluginCohortRecoveryContinuation } from "./update-run-recovery-types.js";
import {
  assertUpdateRecoveryAdmissionFacts,
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
  /** Attribute this required receipt to the enclosing Doctor capture. */
  captureDatabaseWrite?: true;
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
  const sqliteCapture =
    captured.captureDatabaseWrite &&
    context.databaseEngineSelection?.effectiveEngines.state !== "postgres"
      ? captureUpdateDoctorSqliteWrite(context.admission.databasePath)
      : undefined;
  const continuation = captured.pluginCohort;
  let cohortPair: PluginCohortRecoveryPair | undefined;
  let writerClosed = false;
  const assertCurrent = () => {
    // The retained physical maintenance owner replaces our intentionally retired read admission.
    if (!writerClosed) {
      context.admission.assertCurrent();
    }
    captured.signal?.throwIfAborted();
    captured.assertCurrent?.();
    sqliteCapture?.assertCurrent();
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
      busyTimeoutMs: captured.busyTimeoutMs,
      redactPaths: captured.redactPaths,
      sqliteCaptureGeneration: sqliteCapture?.expected,
    }),
  );
  // Retain the accepted receipt before the metadata read yields; settlement owns
  // both the reader and the write that rechecks recovery in its transaction.
  const pending = (async () => {
    if (continuation) {
      const selected = { env: captured.env, path: context.admission.databasePath };
      cohortPair = assertUpdateRecoveryAdmissionFacts(
        await readUpdateRecoveryAdmissionFactsAsync(selected),
        { ...selected, pluginCohort: continuation },
      );
    }
    assertCurrent();
    const pluginCohort = cohortPair
      ? {
          runId: cohortPair.cohort.runId,
          transactionId: cohortPair.cohort.transactionId,
          installKey: cohortPair.cohort.installKey,
        }
      : undefined;
    if (pluginCohort) {
      if (
        !captured.requireNoRecovery ||
        (command.type !== "updateRuns.recordPhase" &&
          command.type !== "updateRuns.recordStep" &&
          command.type !== "updateRuns.recordDiagnostics")
      ) {
        throw new Error("Plugin cohort continuation permits only update progress bookkeeping");
      }
      command.input.pluginCohort = pluginCohort;
    }
    const reply = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute(command),
      {
        existingOnly: command.type !== "updateRuns.create",
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(
          assertCurrent,
          [context.admission.databasePath],
          pluginCohort,
        ),
      },
    );
    if (sqliteCapture) {
      // The writer supplied the exact post-close content generation while native
      // exclusion was held. Closing must settle before publishing that receipt.
      await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
      writerClosed = true;
      assertCurrent();
      if (reply?.kind !== "recorded" || !reply.sqliteWriteReceipt?.afterClose) {
        throw new Error("Update receipt writer did not publish its native close generation.");
      }
      const { readUpdateSqliteDatabaseGenerationPairIsolated } =
        await import("./update-candidate-state.inspection.js");
      const observed = await readUpdateSqliteDatabaseGenerationPairIsolated(
        [context.admission.databasePath],
        { env: captured.env, signal: captured.signal },
      );
      assertCurrent();
      const pathname = context.admission.databasePath;
      const actual = observed.committed[pathname];
      const allowed = new Set([
        reply.sqliteWriteReceipt.after,
        reply.sqliteWriteReceipt.afterClose,
      ]);
      const alternate = observed.emptyReaderAlternates[pathname];
      if (
        actual === undefined ||
        (!allowed.has(actual) && (alternate === undefined || !allowed.has(alternate)))
      ) {
        throw new Error("Update receipt database changed before native close settlement.");
      }
      reply.sqliteWriteReceipt.after = actual ?? null;
    }
    return reply;
  })();
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
  let reply: Awaited<typeof completion>;
  try {
    reply = await completion;
  } catch (error) {
    sqliteCapture?.refuse();
    throw error;
  }
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
  if (sqliteCapture) {
    if (reply.sqliteWriteReceipt?.afterClose) {
      sqliteCapture.accept({
        ...reply.sqliteWriteReceipt,
        after: reply.sqliteWriteReceipt.afterClose,
      });
    } else {
      sqliteCapture.refuse();
    }
  }
  return {
    record: reply.record,
    ...(reply.updateResult ? { updateResult: reply.updateResult } : {}),
  };
}

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

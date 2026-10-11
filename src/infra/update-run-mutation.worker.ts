import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import {
  openExistingOpenClawStateWriter,
  type ExistingOpenClawStateWriter,
} from "../state/openclaw-state-db-existing-write.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { resolveUpdateRunCodecEnv, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import { createUpdateRun } from "./update-run-ledger.js";
import type {
  UpdateRunWriteCommand,
  UpdateRunWriteOperations,
} from "./update-run-mutation.types.js";
import { readRecovery } from "./update-run-recovery-store.js";
import { recordUpdateRunVerificationRecord } from "./update-run-verification.js";
import {
  applyFinishUpdateRun,
  applyUpdateRunDiagnostics,
  applyUpdateRunPhase,
  applyUpdateRunStep,
  isRequiredUpdateRunStep,
  UPDATE_RUN_BOOKKEEPING_TIMEOUT_MS,
  mutateRunInTransaction,
  updateRunLedgerSchema,
} from "./update-run-write.js";

export function openUpdateRunWriter(options: UpdateRunLedgerOptions): ExistingOpenClawStateWriter {
  return openExistingOpenClawStateWriter(options, {
    schemaSql: updateRunLedgerSchema,
    operationLabel: "update.run",
  });
}

export function recordUpdateRunMutationInWorker(
  command: UpdateRunWriteCommand,
  stateOptions: UpdateRunLedgerOptions,
  assertCurrent: (stage: "transaction" | "commit") => void,
  writer: () => ExistingOpenClawStateWriter,
): UpdateRunWriteOperations["updateRuns.recordStep"]["output"] {
  const { input } = command;
  // Recovery exclusion must serialize behind the competing writer too.
  const bookkeeping =
    command.type === "updateRuns.recordStep" &&
    !input.requireNoRecovery &&
    !isRequiredUpdateRunStep(command.input.step);
  const busyTimeoutMs = Math.min(
    input.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    bookkeeping ? UPDATE_RUN_BOOKKEEPING_TIMEOUT_MS : Infinity,
  );
  const options = {
    ...stateOptions,
    busyTimeoutMs,
    redactPaths: input.redactPaths,
  };
  const codecOptions = {
    ...options,
    env: resolveUpdateRunCodecEnv(options.env, input.redactionFacts),
  };
  if (command.type === "updateRuns.create") {
    return {
      kind: "recorded",
      record: createUpdateRun(command.input.run, codecOptions, assertCurrent),
    };
  }
  let entered = false;
  try {
    return writer().run(({ db }) => {
      entered = true;
      // The longer wait is for BEGIN only; mutation and commit keep the normal lock budget.
      if (busyTimeoutMs > OPENCLAW_SQLITE_BUSY_TIMEOUT_MS) {
        setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
      }
      assertCurrent("transaction");
      if (input.requireNoRecovery) {
        const recovery = readRecovery(db, input.runId);
        if (recovery) {
          assertCurrent("commit");
          return { kind: "recovery-required", recovery };
        }
      }
      const record = mutateRunInTransaction(
        db,
        input.runId,
        (current) => {
          if (command.type === "updateRuns.recordPhase") {
            applyUpdateRunPhase(current, command.input.phase, command.input.patch);
          } else if (command.type === "updateRuns.recordStep") {
            applyUpdateRunStep(current, command.input.step);
          } else if (command.type === "updateRuns.finish") {
            applyFinishUpdateRun(current, command.input.result);
          } else if (command.type === "updateRuns.recordVerification") {
            recordUpdateRunVerificationRecord(current, command.input.verification, command.input);
          } else {
            const diagnostics = command.input.diagnostics;
            applyUpdateRunDiagnostics(
              current,
              command.input.preserveRecovery
                ? {
                    ...diagnostics,
                    recovery: current.verification.recovery ?? diagnostics.recovery,
                    rollbackOutcome:
                      current.verification.rollbackOutcome ?? diagnostics.rollbackOutcome,
                  }
                : diagnostics,
            );
          }
        },
        codecOptions,
      );
      assertCurrent("commit");
      return { kind: "recorded", record };
    }, options);
  } catch (cause) {
    if (entered || !isSqliteLockError(cause)) {
      throw cause;
    }
    if (bookkeeping) {
      return { kind: "bookkeeping-skipped" };
    }
    throw new Error(
      "Update history database is locked; required recovery evidence was not recorded. Wait for the writer to finish, then retry `openclaw update`.",
      { cause },
    );
  }
}

import {
  openExistingOpenClawStateWriter,
  type ExistingOpenClawStateWriter,
} from "../state/openclaw-state-db-existing-write.js";
import { resolveUpdateRunCodecEnv, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type {
  UpdateRunWriteCommand,
  UpdateRunWriteOperations,
} from "./update-run-mutation.types.js";
import { readUpdateRuns } from "./update-run-read.kernel.js";
import { readRecovery } from "./update-run-recovery-store.js";
import {
  isUpdateRunNormalCycleAwaiting,
  recordUpdateRunVerificationRecord,
} from "./update-run-verification.js";
import {
  applyUpdateRunPhase,
  applyUpdateRunStep,
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
  writer: ExistingOpenClawStateWriter,
): UpdateRunWriteOperations["updateRuns.recordStep"]["output"] {
  const { input } = command;
  const options = {
    ...stateOptions,
    busyTimeoutMs: input.busyTimeoutMs,
    redactPaths: input.redactPaths,
  };
  const codecOptions = {
    ...options,
    env: resolveUpdateRunCodecEnv(options.env, input.redactionFacts),
  };
  return writer.run(({ db }) => {
    assertCurrent("transaction");
    if (input.requireNoRecovery) {
      const recovery = readRecovery(db, input.runId);
      if (recovery) {
        assertCurrent("commit");
        return { kind: "recovery-required", recovery };
      }
    }
    if (command.type === "updateRuns.recordVerification" && input.normalCycleEligibility) {
      const runs = readUpdateRuns(db, { limit: 32 });
      const candidate = runs.find((run) => run.status !== "skipped" && run.phase === "finished");
      if (
        runs.some((run) => run.status === "running") ||
        candidate?.runId !== input.runId ||
        !candidate ||
        !isUpdateRunNormalCycleAwaiting(
          candidate,
          input.normalCycleEligibility.nowMs,
          input.normalCycleEligibility.maxAgeMs,
        )
      ) {
        assertCurrent("commit");
        return { kind: "not-recorded" };
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
        } else {
          recordUpdateRunVerificationRecord(current, command.input.verification);
        }
      },
      codecOptions,
    );
    assertCurrent("commit");
    return { kind: "recorded", record };
  }, options);
}

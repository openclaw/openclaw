import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import { resolveUpdateRunCodecEnv, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type {
  UpdateRunWriteCommand,
  UpdateRunWriteOperations,
} from "./update-run-mutation.types.js";
import { readRecoveries } from "./update-run-recovery-store.js";
import {
  applyUpdateRunPhase,
  applyUpdateRunStep,
  mutateRunInTransaction,
  updateRunLedgerSchema,
} from "./update-run-write.js";

export function recordUpdateRunMutationInWorker(
  command: UpdateRunWriteCommand,
  stateOptions: UpdateRunLedgerOptions,
  assertCurrent: (stage: "transaction" | "commit") => void,
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
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent("transaction");
      if (input.requireNoRecovery) {
        const recovery = readRecoveries(db).find((record) => record.runId === input.runId);
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
          } else {
            applyUpdateRunStep(current, command.input.step);
          }
        },
        codecOptions,
      );
      assertCurrent("commit");
      return { kind: "recorded", record };
    },
    options,
    {
      schemaSql: updateRunLedgerSchema,
      operationLabel: "update.run",
      busyTimeoutMs: options.busyTimeoutMs,
    },
  );
}

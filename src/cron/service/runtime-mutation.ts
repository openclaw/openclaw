import {
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { withCronReceiptAuthorityMutation } from "../store/receipt-authority-owner.js";
import type { CronRunReceipt } from "../store/run-receipt.types.js";
import type {
  CronRuntimeMutationContracts,
  CronReceiptRevisionRefusal,
  CronJobMutationRefusal,
  CronRuntimeMutationType,
  CronRuntimeWorkerOperations,
} from "../store/runtime-worker.types.js";

type CronRuntimeMutationParams<Type extends CronRuntimeMutationType> = {
  context: OpenClawStateWorkerContext;
  type: Type;
  input: CronRuntimeMutationContracts[Type]["input"];
  snapshot: CronRuntimeMutationContracts[Type]["snapshot"];
  assertCurrent: () => void;
  publish: (outcome: CronRuntimeMutationContracts[Type]["outcome"]) => void;
  onSettled?: (outcome: "committed" | "not-committed" | "unknown") => void;
  onRolledBackConflict?: (receipt: CronRunReceipt) => void;
  onRolledBackReceiptRevision?: (refusal: CronReceiptRevisionRefusal) => never;
  onRolledBackMutation?: (refusal: CronJobMutationRefusal) => never;
};

/** Push policy before dispatch; all current-row decisions remain in the worker. */
export function runCronRuntimeMutation<Type extends CronRuntimeMutationType>(
  params: CronRuntimeMutationParams<Type>,
): Promise<void> {
  const snapshot = structuredClone(params.snapshot);
  return withCronReceiptAuthorityMutation(
    params.context,
    async (authority) => {
      let settled: "committed" | "not-committed" | "unknown" = "not-committed";
      const assertCurrent = () => {
        authority.assertCurrent();
        params.context.admission.assertCurrent();
        params.assertCurrent();
      };
      try {
        await runOpenClawStateWorkerOperation(
          authority.context,
          async (scope) => {
            // Config or caller authority may change after dispatch; cron accepts that race.
            assertCurrent();
            const command = {
              type: params.type,
              input: { ...params.input, snapshot },
              // SAFETY: Type selects this private command's input, snapshot, and outcome together.
            } as SqliteWorkerCommand<CronRuntimeWorkerOperations>;
            settled = "unknown";
            const result = await scope.execute(command).catch((error: unknown) => {
              if (!hasSqliteWorkerOutcomeUnknown(error)) {
                settled = "not-committed";
              }
              throw error;
            });
            if ("outcome" in result) {
              settled = "committed";
              params.publish(result.outcome);
              return;
            }
            settled = "not-committed";
            if ("conflict" in result && params.onRolledBackConflict) {
              params.onRolledBackConflict(result.conflict);
            } else if ("receiptRevision" in result && params.onRolledBackReceiptRevision) {
              params.onRolledBackReceiptRevision(result.receiptRevision);
            } else if ("mutationRefusal" in result && params.onRolledBackMutation) {
              params.onRolledBackMutation(result.mutationRefusal);
            } else {
              throw new Error("Cron mutation returned an unexpected refusal");
            }
          },
          { assertCurrent },
        );
      } finally {
        params.onSettled?.(settled);
      }
    },
    {
      settlement:
        params.type === "cron.finishReceipt" || params.type === "cron.releaseReservations",
    },
  );
}

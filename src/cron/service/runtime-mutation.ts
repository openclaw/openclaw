import { randomUUID } from "node:crypto";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  SqliteWorkerNativeSettlementOwner,
  SqliteWorkerOperationSettlement,
} from "../../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  withCronReceiptAuthorityMutation,
  type CronReceiptAuthorityMutation,
} from "../store/receipt-authority-owner.js";
import type { CronRunReceipt } from "../store/run-receipt.types.js";
import type { CronRuntimeMutationContracts } from "../store/runtime-mutation.types.js";
import type {
  CronReceiptRevisionRefusal,
  CronJobMutationRefusal,
  CronRuntimeMutationType,
  CronRuntimeWorkerOperations,
} from "../store/runtime-worker.types.js";

type CronRuntimeMutationParams<Type extends CronRuntimeMutationType> = {
  context: OpenClawStateWorkerContext;
  type: Type;
  input: CronRuntimeMutationContracts[NoInfer<Type>]["input"];
  assertCurrent: () => void;
  policy: {
    value: CronRuntimeMutationContracts[NoInfer<Type>]["preparation"];
    assertCurrent: (outcome?: CronRuntimeMutationContracts[NoInfer<Type>]["outcome"]) => void;
  };
  publish: (outcome: CronRuntimeMutationContracts[NoInfer<Type>]["outcome"]) => void;
  onSettled?: (outcome: "committed" | "not-committed" | "unknown") => void;
  onRolledBackConflict?: (receipt: CronRunReceipt) => void;
  onRolledBackReceiptRevision?: (refusal: CronReceiptRevisionRefusal) => never;
  onRolledBackMutation?: (refusal: CronJobMutationRefusal) => never;
};

/** One settlement owner serves typed cron mutations; callbacks and database handles stay local. */
export function runCronRuntimeMutation<Type extends CronRuntimeMutationType>(
  params: CronRuntimeMutationParams<Type>,
): Promise<void> {
  return withCronReceiptAuthorityMutation(
    params.context,
    (authority) => runEnrolledCronRuntimeMutation(params, authority),
    {
      settlement:
        params.type === "cron.finishReceipt" || params.type === "cron.releaseReservations",
    },
  );
}

async function runEnrolledCronRuntimeMutation<Type extends CronRuntimeMutationType>(
  params: CronRuntimeMutationParams<Type>,
  authority: CronReceiptAuthorityMutation,
): Promise<void> {
  const nonce = randomUUID();
  let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
  let native: SqliteWorkerNativeSettlementOwner | undefined;
  let bytes: Uint8Array | undefined;
  let published = false;
  let onRolledBack: (() => void) | undefined;
  const assertCurrent = () => {
    authority.assertCurrent();
    params.context.admission.assertCurrent();
    params.assertCurrent();
  };
  const publishCommitted = () => {
    const committed = native?.committed?.facts;
    if (published || !isRecord(committed) || committed.nonce !== nonce) {
      return;
    }
    if (!bytes) {
      throw new Error("Committed cron mutation lost its retained outcome");
    }
    // SAFETY: this command's private worker retained these bytes before its matching native commit.
    const outcome = deserialize(bytes) as CronRuntimeMutationContracts[Type]["outcome"];
    published = true;
    bytes = undefined;
    params.publish(outcome);
  };
  try {
    await runOpenClawStateWorkerOperation(
      authority.context,
      async (scope) => {
        try {
          const command = {
            type: params.type,
            input: { ...params.input, nonce, prepared: params.policy.value },
            // SAFETY: Type selects both the command and its input from the same contract map.
          } as SqliteWorkerCommand<CronRuntimeWorkerOperations>;
          const result = await scope.execute(command);
          if (result.nonce !== nonce) {
            throw new Error("Cron mutation returned a different operation nonce");
          }
          if ("conflict" in result) {
            if (params.type !== "cron.reserveRuns" || !params.onRolledBackConflict) {
              throw new Error("Cron mutation returned an unexpected reservation conflict");
            }
            const receipt = result.conflict;
            onRolledBack = () => params.onRolledBackConflict!(receipt);
          }
          if ("receiptRevision" in result) {
            if (params.type !== "cron.finalizeRuns" || !params.onRolledBackReceiptRevision) {
              throw new Error("Cron mutation returned an unexpected receipt revision refusal");
            }
            const refusal = result.receiptRevision;
            onRolledBack = () => params.onRolledBackReceiptRevision!(refusal);
          }
          if ("mutationRefusal" in result) {
            if (params.type !== "cron.mutateJobs" || !params.onRolledBackMutation) {
              throw new Error("Cron mutation returned an unexpected job mutation refusal");
            }
            const refusal = result.mutationRefusal;
            onRolledBack = () => params.onRolledBackMutation!(refusal);
          }
        } finally {
          await settlement;
          publishCommitted();
        }
      },
      {
        assertCurrent,
        createAdmission(retained) {
          settlement = retained.settled;
          let phase: "transaction" | "commit" | "settling" = "transaction";
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            const facts = request.facts;
            {
              assertCurrent();
              if (!isRecord(facts) || facts.nonce !== nonce || request.stage !== phase) {
                throw new Error("Cron mutation differs from its retained transaction owner");
              }
              if (request.stage === "transaction") {
                phase = "commit";
              } else {
                if (!(facts.bytes instanceof Uint8Array)) {
                  throw new Error("Cron mutation has no prepared outcome");
                }
                // The worker owns the complete result; host callbacks only recheck live custody.
                params.policy.assertCurrent(
                  // SAFETY: The matching nonce binds worker-owned bytes to this command type.
                  deserialize(facts.bytes) as CronRuntimeMutationContracts[Type]["outcome"],
                );
                bytes = facts.bytes;
                phase = "settling";
              }
            }
            if (!grant()) {
              throw new Error("Cron mutation admission expired");
            }
          }, authority.attachment);
          authority.observe(admission, retained);
          native = admission;
          return { nativeLocations: [params.context.admission.databasePath], admission };
        },
      },
    );
    if (onRolledBack) {
      const settled = await settlement;
      if (
        native?.committed ||
        native?.settlement?.kind !== "completed" ||
        settled?.kind !== "completed"
      ) {
        throw new Error("Cron mutation refusal has no confirmed native rollback");
      }
      onRolledBack();
    } else if (!published) {
      throw new Error("Cron mutation did not publish a committed outcome");
    }
  } finally {
    const settled = await settlement;
    try {
      publishCommitted();
    } finally {
      params.onSettled?.(
        native?.committed
          ? "committed"
          : settled === undefined ||
              settled.kind === "not-entered" ||
              native?.settlement?.kind === "completed"
            ? "not-committed"
            : "unknown",
      );
      bytes = undefined;
    }
  }
}

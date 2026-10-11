import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  CronRunReceiptRevisionError,
  retainCronRunReceiptSettlement,
  type CronRunReceiptSettlementDisposition,
} from "../store/run-receipt-store.js";
import type {
  CronRuntimeMutationContracts,
  CronReceiptTerminal,
  CronRunFinalizationOutcome,
} from "../store/runtime-worker.types.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import type { CronServiceState } from "./state.js";

export type CronFinalizationReceipt = {
  terminal: CronReceiptTerminal;
  context: OpenClawStateWorkerContext;
  allowMissingJob: boolean;
  disposition?: CronRunReceiptSettlementDisposition;
};

/** The worker applies completed outcomes to its current rows and settles receipts together. */
export async function finalizeCronRuntimeRows(params: {
  state: CronServiceState;
  context: OpenClawStateWorkerContext;
  outcomes: CronRunFinalizationOutcome[];
  receipts: CronFinalizationReceipt[];
}): Promise<CronRuntimeMutationContracts["cron.finalizeRuns"]["outcome"]> {
  const storeKey = cronStoreKey(params.state.deps.storePath);
  const retained = params.receipts.map((receipt) => ({
    receipt,
    settlement: retainCronRunReceiptSettlement(receipt.terminal.handle),
  }));
  let result: CronRuntimeMutationContracts["cron.finalizeRuns"]["outcome"] | undefined;
  try {
    await runCronRuntimeMutation({
      context: params.context,
      type: "cron.finalizeRuns",
      input: {
        storeKey,
        jobIds: params.outcomes.map((outcome) => outcome.jobId),
        receipts: retained.map(({ receipt }) => ({
          terminal: receipt.terminal,
          allowMissingJob: receipt.allowMissingJob,
          allowUnavailable:
            receipt.terminal.status === "error" && receipt.disposition === "owner-unavailable",
        })),
      },
      snapshot: {
        nowMs: params.state.deps.nowMs(),
        defaultAgentId: params.state.deps.resolveDefaultAgentId
          ? params.state.deps.resolveDefaultAgentId()
          : params.state.deps.defaultAgentId,
        cronConfig: params.state.deps.cronConfig,
        outcomes: params.outcomes,
        deferredReceiptIds: retained
          .filter(({ settlement }) => settlement.pending)
          .map(({ receipt }) => receipt.terminal.handle.receiptId),
      },
      assertCurrent() {
        params.context.admission.assertCurrent();
        if (cronStoreKey(params.state.deps.storePath) !== storeKey) {
          throw new Error("Cron finalization store partition changed");
        }
        for (const { receipt, settlement } of retained) {
          receipt.context.admission.assertCurrent();
          if (receipt.context.admission.databasePath !== params.context.admission.databasePath) {
            throw new Error("Cron finalization receipts belong to different physical stores");
          }
          settlement.assertCurrent();
          if (
            !(receipt.terminal.status === "error" && receipt.disposition === "owner-unavailable") &&
            params.state.deps.isAgentAvailable?.(receipt.terminal.handle.agentId, undefined, {
              deletionBlocked: false,
            }) === false
          ) {
            throw new CronRunReceiptRevisionError(
              receipt.terminal.handle.receiptId,
              describeUnavailableCronAgent(receipt.terminal.handle.agentId),
              "owner-unavailable",
            );
          }
        }
      },
      publish(outcome) {
        result = outcome;
        if (outcome.changed) {
          noteCronJobsStoreCommit(storeKey);
        }
        for (const entry of outcome.logs) {
          params.state.deps.log[entry.level](entry.fields, entry.message);
        }
        for (const { receipt, settlement } of retained) {
          if (settlement.pending) {
            settlement.deferFinish(receipt.terminal, receipt.context);
          }
        }
      },
      onRolledBackReceiptRevision(refusal) {
        throw new CronRunReceiptRevisionError(refusal.receiptId, refusal.message, refusal.reason);
      },
    });
    if (!result) {
      throw new Error("Cron finalization did not return its committed outcome");
    }
    return result;
  } finally {
    for (const { settlement } of retained) {
      settlement.release();
    }
  }
}

import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  CronRunReceiptRevisionError,
  retainCronRunReceiptSettlement,
  type CronRunReceiptSettlementDisposition,
} from "../store/run-receipt-store.js";
import type { CronReceiptTerminal } from "../store/runtime-worker.types.js";
import type { CronJob } from "../types.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import type { CronServiceState } from "./state.js";

export type CronFinalizationReceipt = {
  terminal: CronReceiptTerminal;
  context: OpenClawStateWorkerContext;
  allowMissingJob: boolean;
  disposition?: CronRunReceiptSettlementDisposition;
};

/** Parent policy consumes transaction-held rows; the worker commits rows and receipts together. */
export async function finalizeCronRuntimeRows<Value>(params: {
  state: CronServiceState;
  context: OpenClawStateWorkerContext;
  jobIds: string[];
  receipts: CronFinalizationReceipt[];
  markers: Array<CronActiveJobMarker | undefined>;
  mutate: (facts: {
    jobs: ReadonlyMap<string, CronJob>;
    retiredTriggerReceiptIds: ReadonlySet<string>;
  }) => {
    jobs: CronJob[];
    deletedJobIds: string[];
    value: Value;
  };
}): Promise<Value> {
  const storeKey = cronStoreKey(params.state.deps.storePath);
  const retained = params.receipts.map((receipt) => ({
    receipt,
    settlement: retainCronRunReceiptSettlement(receipt.terminal.handle),
  }));
  const resolveDefaultAgentId = () =>
    params.state.deps.resolveDefaultAgentId
      ? params.state.deps.resolveDefaultAgentId()
      : params.state.deps.defaultAgentId;
  let result: { value: Value } | undefined;
  let committed = false;
  let settlementOutcome: "committed" | "not-committed" | "unknown" | undefined;
  const assertSourceCurrent = () => {
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
    }
  };
  try {
    await runCronRuntimeMutation({
      context: params.context,
      type: "cron.finalizeRuns",
      input: {
        storeKey,
        jobIds: [...params.jobIds],
        receipts: retained.map(({ receipt }) => ({
          terminal: structuredClone(receipt.terminal),
          allowMissingJob: receipt.allowMissingJob,
        })),
      },
      assertCurrent: assertSourceCurrent,
      prepare(facts) {
        const defaultAgentId = resolveDefaultAgentId();
        const receiptFacts = new Map(facts.receipts.map((fact) => [fact.receiptId, fact]));
        const markers = params.markers.map((marker) => ({
          marker,
          jobRemoved: marker?.jobRemoved,
          scheduleMutated: marker?.scheduleMutated,
          triggerMutated: marker?.triggerMutated,
        }));
        const assertCurrent = () => {
          assertSourceCurrent();
          if (resolveDefaultAgentId() !== defaultAgentId) {
            throw new Error("Cron finalization default agent changed");
          }
          // Retirement suppresses publication but does not abandon durable completion.
          for (const captured of markers) {
            if (
              captured.marker?.jobRemoved !== captured.jobRemoved ||
              captured.marker?.scheduleMutated !== captured.scheduleMutated ||
              captured.marker?.triggerMutated !== captured.triggerMutated
            ) {
              throw new Error("Cron finalization policy changed before commit");
            }
          }
          for (const { receipt } of retained) {
            const { handle } = receipt.terminal;
            const fact = receiptFacts.get(handle.receiptId);
            if (!fact) {
              throw new Error("Cron finalization omitted a receipt's authority facts");
            }
            const recordsUnavailableGuard =
              receipt.terminal.status === "error" && receipt.disposition === "owner-unavailable";
            if (
              (fact.deletionBlocked ||
                params.state.deps.isAgentAvailable?.(handle.agentId, undefined, fact) === false) &&
              !recordsUnavailableGuard
            ) {
              throw new CronRunReceiptRevisionError(
                handle.receiptId,
                describeUnavailableCronAgent(handle.agentId),
                "owner-unavailable",
              );
            }
          }
          assertSourceCurrent();
        };
        assertCurrent();
        const mutation = params.mutate({
          jobs: new Map(facts.jobs.map((job) => [job.id, job])),
          retiredTriggerReceiptIds: new Set(
            facts.receipts.filter((fact) => fact.triggerStateRetired).map((fact) => fact.receiptId),
          ),
        });
        assertCurrent();
        result = { value: mutation.value };
        return {
          value: {
            defaultAgentId,
            jobs: mutation.jobs,
            deletedJobIds: mutation.deletedJobIds,
            deferredReceiptIds: retained
              .filter(({ settlement }) => settlement.pending)
              .map(({ receipt }) => receipt.terminal.handle.receiptId),
          },
          assertCurrent,
        };
      },
      publish(outcome) {
        committed = true;
        if (outcome.changed) {
          noteCronJobsStoreCommit(storeKey);
        }
        for (const { receipt, settlement } of retained) {
          if (settlement.pending) {
            settlement.deferFinish(receipt.terminal, receipt.context);
          }
        }
      },
      onSettled(outcome) {
        settlementOutcome = outcome;
      },
      onRolledBackReceiptRevision(refusal) {
        if (
          !retained.some(({ receipt }) => receipt.terminal.handle.receiptId === refusal.receiptId)
        ) {
          throw new Error("Cron finalization refused an unrelated receipt");
        }
        throw new CronRunReceiptRevisionError(refusal.receiptId, refusal.message, refusal.reason);
      },
    });
    if (!committed || !result) {
      throw new Error("Cron finalization did not retain its committed policy result");
    }
    return result.value;
  } catch (error) {
    if (error instanceof CronRunReceiptRevisionError && settlementOutcome !== "not-committed") {
      // Only confirmed rollback permits the caller's stale-receipt compensation.
      throw new Error("Cron finalization could not certify an uncommitted receipt refusal", {
        cause: error,
      });
    }
    throw error;
  } finally {
    for (const { settlement } of retained) {
      settlement.release();
    }
  }
}

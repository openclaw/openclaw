import { isDeepStrictEqual } from "node:util";
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
import type { CronRuntimeMutationContracts } from "../store/runtime-mutation.types.js";
import type { CronReceiptTerminal } from "../store/runtime-worker.types.js";
import { prepareCronFailureAlertPolicies } from "./failure-alerts.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import type { CronServiceState } from "./state.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";

export type CronFinalizationReceipt = {
  terminal: CronReceiptTerminal;
  context: OpenClawStateWorkerContext;
  allowMissingJob: boolean;
  disposition?: CronRunReceiptSettlementDisposition;
};

/** Capture live host custody; the worker computes and commits authoritative rows and receipts. */
export async function finalizeCronRuntimeRows(params: {
  state: CronServiceState;
  context: OpenClawStateWorkerContext;
  jobIds: string[];
  receipts: CronFinalizationReceipt[];
  markers: Array<CronActiveJobMarker | undefined>;
  outcomes: readonly TimedCronRunOutcome[];
}): Promise<CronRuntimeMutationContracts["cron.finalizeRuns"]["outcome"]> {
  const storeKey = cronStoreKey(params.state.deps.storePath);
  const retained = params.receipts.map((receipt) => ({
    receipt,
    settlement: retainCronRunReceiptSettlement(receipt.terminal.handle),
  }));
  const resolveDefaultAgentId = () =>
    params.state.deps.resolveDefaultAgentId
      ? params.state.deps.resolveDefaultAgentId()
      : params.state.deps.defaultAgentId;
  let result: CronRuntimeMutationContracts["cron.finalizeRuns"]["outcome"] | undefined;
  let committed = false;
  let settlementOutcome: "committed" | "not-committed" | "unknown" = "not-committed";
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
          disposition: receipt.disposition,
        })),
      },
      assertCurrent: assertSourceCurrent,
      policy: (() => {
        const alerts = prepareCronFailureAlertPolicies(params.state, params.jobIds);
        const defaultAgentId = resolveDefaultAgentId();
        const cronConfig = structuredClone(params.state.deps.cronConfig);
        const markers = params.markers.map((marker) => ({
          marker,
          jobRemoved: marker?.jobRemoved,
          scheduleMutated: marker?.scheduleMutated,
          triggerMutated: marker?.triggerMutated,
        }));
        const assertCurrent = () => {
          alerts.assertCurrent();
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
            const recordsUnavailableGuard =
              receipt.terminal.status === "error" && receipt.disposition === "owner-unavailable";
            if (
              params.state.deps.isAgentAvailable?.(handle.agentId, undefined, {
                deletionBlocked: false,
              }) === false &&
              !recordsUnavailableGuard
            ) {
              throw new CronRunReceiptRevisionError(
                handle.receiptId,
                describeUnavailableCronAgent(handle.agentId),
                "owner-unavailable",
              );
            }
          }
          if (!isDeepStrictEqual(cronConfig, params.state.deps.cronConfig)) {
            throw new Error("Cron finalization configuration changed");
          }
          assertSourceCurrent();
        };
        assertCurrent();
        return {
          value: {
            defaultAgentId,
            failureAlerts: alerts.policies,
            nowMs: params.state.deps.nowMs(),
            cronConfig,
            outcomes: params.outcomes.map((outcome) => {
              const {
                activeJobMarker,
                runReceiptContext: _runReceiptContext,
                reservationIdentity: _reservationIdentity,
                request,
                ...completedResult
              } = outcome;
              return structuredClone({
                ...completedResult,
                activeJobMarker: activeJobMarker
                  ? {
                      jobRemoved: activeJobMarker.jobRemoved,
                      scheduleMutated: activeJobMarker.scheduleMutated,
                      triggerMutated: activeJobMarker.triggerMutated,
                    }
                  : undefined,
                request: request
                  ? {
                      preserveCadence: request.preserveCadence,
                      scheduleOwnershipAtMs: request.scheduleOwnershipAtMs,
                    }
                  : undefined,
              });
            }),
            deferredReceiptIds: retained
              .filter(({ settlement }) => settlement.pending)
              .map(({ receipt }) => receipt.terminal.handle.receiptId),
          },
          assertCurrent,
        };
      })(),
      publish(outcome) {
        result = outcome;
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
    return result;
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

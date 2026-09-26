import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  CronRunReceiptRevisionError,
  releaseLocalCronRunReceiptOwnership,
  retainCronRunReceiptSettlement,
} from "../store/run-receipt-store.js";
import type { CronRuntimeMutationContracts } from "../store/runtime-mutation.types.js";
import type { CronReceiptTerminal } from "../store/runtime-worker.types.js";
import type { CronJob } from "../types.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import type { CronServiceState } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

export type QueuedCronRunReservation = { jobId: string; reservationIdentity: object };

function currentDefaultAgentId(state: CronServiceState) {
  return state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId;
}

/** Callers hold the partition lock through committed publication and execution handoff. */
export async function activateReservedCronRun(params: {
  state: CronServiceState;
  job: CronJob;
  reservationIdentity: object;
  startedAtMs: number;
  commitGuard?: () => void;
  onExitSchedule?: Extract<CronJob["schedule"], { kind: "on-exit" }>;
}): Promise<CronRuntimeMutationContracts["cron.activateRun"]["outcome"]["activation"]> {
  const { state } = params;
  const reservation = state.queuedRunReservationsByJobId.get(params.job.id);
  if (!reservation || reservation.identity !== params.reservationIdentity) {
    return undefined;
  }
  const markerAtMs = reservation.markerAtMs;
  const runReceipt = reservation.runReceipt;
  const storeKey = cronStoreKey(state.deps.storePath);
  const context = captureOpenClawStateWorkerContext();
  let activation: CronRuntimeMutationContracts["cron.activateRun"]["outcome"]["activation"];
  await runCronRuntimeMutation({
    context,
    type: "cron.activateRun",
    input: {
      storeKey,
      handle: { ...runReceipt },
      startedAtMs: params.startedAtMs,
      onExitSchedule: params.onExitSchedule ? { ...params.onExitSchedule } : undefined,
    },
    assertCurrent() {
      params.commitGuard?.();
      if (
        state.queuedRunReservationsByJobId.get(params.job.id) !== reservation ||
        reservation.markerAtMs !== markerAtMs ||
        reservation.runReceipt !== runReceipt
      ) {
        throw new CronRunReceiptRevisionError(
          runReceipt.receiptId,
          "cron reservation changed before activation",
        );
      }
    },
    prepare() {
      const defaultAgentId = currentDefaultAgentId(state);
      return {
        value: { markerAtMs, defaultAgentId },
        assertCurrent() {
          if (currentDefaultAgentId(state) !== defaultAgentId) {
            throw new CronRunReceiptRevisionError(runReceipt.receiptId);
          }
        },
      };
    },
    publish(committed) {
      activation = committed.activation;
      if (!activation) {
        return;
      }
      noteCronJobsStoreCommit(storeKey);
      applyCronRuntimeRowsToState(state, [activation.job]);
      reservation.markerAtMs = params.startedAtMs;
      reservation.runReceipt = activation.receipt;
      reservation.activationPreviousLastError = { value: activation.previousLastError };
    },
  });
  return activation;
}

export async function releaseReservedCronRuns(params: {
  state: CronServiceState;
  reservations: readonly QueuedCronRunReservation[];
  restoreLastError?: boolean;
  recompute?: boolean;
  terminal?: CronReceiptTerminal;
  requireCurrentReceipt?: boolean;
  onSettled: (outcome: "committed" | "not-committed" | "unknown") => void;
}): Promise<void> {
  const { state } = params;
  const storeKey = cronStoreKey(state.deps.storePath);
  const context = captureOpenClawStateWorkerContext();
  const retained = params.terminal
    ? retainCronRunReceiptSettlement(params.terminal.handle)
    : undefined;
  try {
    await runCronRuntimeMutation({
      context,
      type: "cron.releaseReservations",
      input: {
        storeKey,
        jobIds: params.reservations.map(({ jobId }) => jobId),
        restoreLastError: params.restoreLastError !== false,
        recompute: params.recompute === true,
        terminal: params.terminal,
        requireCurrentReceipt: params.requireCurrentReceipt,
      },
      assertCurrent() {
        retained?.assertCurrent();
      },
      prepare(facts) {
        const defaultAgentId = currentDefaultAgentId(state);
        const owners = params.reservations
          .map((reservation) => ({
            ...reservation,
            owner: state.queuedRunReservationsByJobId.get(reservation.jobId),
          }))
          .filter(({ owner, reservationIdentity }) => owner?.identity === reservationIdentity);
        const reservations = owners.map(({ jobId, owner }) => ({
          jobId,
          markerAtMs: owner!.markerAtMs,
          runReceipt: { ...owner!.runReceipt },
          activationPreviousLastError: owner!.activationPreviousLastError
            ? { ...owner!.activationPreviousLastError }
            : undefined,
        }));
        const assertAvailable = () => {
          if (
            params.requireCurrentReceipt &&
            params.terminal &&
            (facts.deletionBlocked ||
              state.deps.isAgentAvailable?.(params.terminal.handle.agentId, undefined, facts) ===
                false)
          ) {
            throw new CronRunReceiptRevisionError(
              params.terminal.handle.receiptId,
              describeUnavailableCronAgent(params.terminal.handle.agentId),
              "owner-unavailable",
            );
          }
        };
        assertAvailable();
        return {
          value: {
            nowMs: state.deps.nowMs(),
            defaultAgentId,
            reservations,
            deferTerminal: retained?.pending === true,
          },
          assertCurrent() {
            assertAvailable();
            if (currentDefaultAgentId(state) !== defaultAgentId) {
              throw new Error("Cron default owner changed before cleanup");
            }
            for (const [index, { jobId, owner }] of owners.entries()) {
              const prepared = reservations[index]!;
              if (
                state.queuedRunReservationsByJobId.get(jobId) !== owner ||
                owner?.markerAtMs !== prepared.markerAtMs ||
                owner.runReceipt.receiptId !== prepared.runReceipt.receiptId ||
                owner.runReceipt.startedAtMs !== prepared.runReceipt.startedAtMs
              ) {
                throw new Error("Cron reservation ownership changed before cleanup");
              }
            }
          },
        };
      },
      publish(committed) {
        if (params.terminal && retained?.pending) {
          retained.deferFinish(params.terminal, context);
        }
        if (committed.jobs.length > 0) {
          noteCronJobsStoreCommit(storeKey);
        }
        try {
          runPostPersistCronNotifications(state, committed.notifications);
          applyCronRuntimeRowsToState(state, committed.jobs);
          for (const entry of committed.logs) {
            state.deps.log[entry.level](entry.fields, entry.message);
          }
        } finally {
          releaseReservationOwnership(state, params.reservations);
        }
      },
      onSettled: params.onSettled,
    });
  } finally {
    retained?.release();
  }
}

/** Release exact local identities only after accepted work has settled. */
export function releaseReservationOwnership(
  state: CronServiceState,
  reservations: readonly QueuedCronRunReservation[],
): void {
  for (const reservation of reservations) {
    const ownership = state.queuedRunReservationsByJobId.get(reservation.jobId);
    if (ownership?.identity !== reservation.reservationIdentity) {
      continue;
    }
    releaseLocalCronRunReceiptOwnership(ownership.runReceipt);
    state.queuedRunReservationsByJobId.delete(reservation.jobId);
  }
}

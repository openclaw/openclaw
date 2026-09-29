import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { resolveCronJobEffectiveAgentId, tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimLocalCronRunReceiptOwnership,
  CronRunReceiptRevisionError,
  exactCronRunReceiptMatches,
  isCronRunReceiptOwnerStale,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
  retainCronRunReceiptSettlement,
} from "../store/run-receipt-store.js";
import type { CronRunReceipt, CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronRuntimeMutationContracts } from "../store/runtime-mutation.types.js";
import type { CronReceiptTerminal } from "../store/runtime-worker.types.js";
import type { CronJob } from "../types.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import type { CronServiceState } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

export type QueuedCronRunReservation = { jobId: string; reservationIdentity: object };

function currentDefaultAgentId(state: CronServiceState) {
  return state.deps.resolveDefaultAgentId
    ? state.deps.resolveDefaultAgentId()
    : state.deps.defaultAgentId;
}

export async function reserveCronRuns(params: {
  state: CronServiceState;
  context: OpenClawStateWorkerContext;
  candidates: ReadonlyMap<string, CronJob>;
  immediateJobIds?: ReadonlySet<string>;
  reservedAtMs: number;
  requestRunId?: string;
  preserveSchedule: boolean;
  scheduleOwnershipAtMs: number;
  onExit: boolean;
  assertCurrent: () => void;
  onCommitted: (outcome: CronRuntimeMutationContracts["cron.reserveRuns"]["outcome"]) => void;
}): Promise<CronRunReceipt | undefined> {
  const { state } = params;
  const prospective: CronRunReceiptHandle[] = [];
  let committed = false;
  let conflict: CronRunReceipt | undefined;
  try {
    await runCronRuntimeMutation({
      context: params.context,
      type: "cron.reserveRuns",
      input: {
        storeKey: cronStoreKey(state.deps.storePath),
        proposals: [...params.candidates.values()].map((job) => ({
          jobId: job.id,
          enabled: job.enabled,
          configRevision: resolveCronJobConfigRevision(job),
          nextRunAtMs: job.state.nextRunAtMs,
          lastRunAtMs: job.state.lastRunAtMs,
          lastRunStatus: job.state.lastRunStatus,
          immediate: params.immediateJobIds?.has(job.id) === true,
        })),
        reservedAtMs: params.reservedAtMs,
        preserveSchedule: params.preserveSchedule,
        scheduleOwnershipAtMs: params.scheduleOwnershipAtMs,
        onExit: params.onExit,
      },
      assertCurrent: params.assertCurrent,
      prepare(facts) {
        const defaultAgentId = currentDefaultAgentId(state);
        const observed = new Map(facts.receipts.map((receipt) => [receipt.jobId, receipt]));
        const owners = new Map(
          [...params.candidates.keys()].map((jobId) => {
            const owner = state.queuedRunReservationsByJobId.get(jobId);
            return [
              jobId,
              {
                owner,
                markerAtMs: owner?.markerAtMs,
                lifecycleGeneration: owner?.lifecycleGeneration,
                handle: owner ? { ...owner.runReceipt } : undefined,
              },
            ] as const;
          }),
        );
        const claims = [...params.candidates.values()].map((job) =>
          prepareCronRunReceiptClaim({
            storePath: state.deps.storePath,
            job: params.onExit ? { ...job, enabled: false } : job,
            agentId: resolveCronJobEffectiveAgentId(job, currentDefaultAgentId(state)),
            startedAtMs: params.reservedAtMs,
            requestRunId: params.requestRunId,
            observed: observed.get(job.id),
          }),
        );
        for (const claim of claims) {
          claimLocalCronRunReceiptOwnership(claim.handle);
          prospective.push(claim.handle);
        }
        const replacements = [...owners.values()].flatMap(({ handle }) => (handle ? [handle] : []));
        return {
          value: { defaultAgentId, claims, replacements },
          assertCurrent() {
            const currentDefault = currentDefaultAgentId(state);
            for (const claim of claims) {
              if (
                tryResolveCronJobEffectiveAgentId(
                  params.candidates.get(claim.handle.jobId)!,
                  currentDefault,
                ) !== claim.handle.agentId
              ) {
                throw new Error("Cron job owner changed before reservation");
              }
            }
            for (const [jobId, { owner, markerAtMs, lifecycleGeneration, handle }] of owners) {
              if (
                state.queuedRunReservationsByJobId.get(jobId) !== owner ||
                owner?.markerAtMs !== markerAtMs ||
                owner?.lifecycleGeneration !== lifecycleGeneration ||
                (handle && !exactCronRunReceiptMatches(owner?.runReceipt, handle))
              ) {
                throw new Error("Cron local reservation changed before commit");
              }
            }
            for (const claim of claims) {
              if (
                claim.observed &&
                claim.observedStale !==
                  isCronRunReceiptOwnerStale(claim.observed, params.reservedAtMs)
              ) {
                throw new Error("Cron receipt liveness changed before reservation commit");
              }
            }
          },
        };
      },
      publish(outcome) {
        committed = true;
        const claimed = new Set(outcome.reservations.map(({ runReceipt }) => runReceipt.receiptId));
        for (const handle of prospective) {
          if (!claimed.has(handle.receiptId)) {
            releaseLocalCronRunReceiptOwnership(handle);
          }
        }
        params.onCommitted(outcome);
        if (outcome.reservations.length > 0) {
          noteCronJobsStoreCommit(cronStoreKey(state.deps.storePath));
        }
      },
      onRolledBackConflict(receipt) {
        conflict = receipt;
      },
    });
    return conflict;
  } finally {
    if (!committed) {
      // Native settlement has joined; an unlaunched uncertain receipt remains recoverable.
      for (const handle of prospective) {
        releaseLocalCronRunReceiptOwnership(handle);
      }
    }
  }
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
  context?: OpenClawStateWorkerContext;
  reservations: readonly QueuedCronRunReservation[];
  restoreLastError?: boolean;
  recompute?: boolean;
  terminal?: CronReceiptTerminal;
  requireCurrentReceipt?: boolean;
  onSettled: (outcome: "committed" | "not-committed" | "unknown") => void;
}): Promise<void> {
  const { state } = params;
  const storeKey = cronStoreKey(state.deps.storePath);
  const context = params.context ?? captureOpenClawStateWorkerContext();
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

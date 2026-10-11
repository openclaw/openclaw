import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimLocalCronRunReceiptOwnership,
  listLocallyOwnedCronRunReceiptIds,
  CronRunReceiptRevisionError,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
  retainCronRunReceiptSettlement,
} from "../store/run-receipt-store.js";
import type { CronRunReceipt, CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type {
  CronRuntimeMutationContracts,
  CronReceiptTerminal,
  CronReservationReleasePolicy,
} from "../store/runtime-worker.types.js";
import type { CronJob } from "../types.js";
import {
  prepareCronNotificationRouting,
  resolveCronNotificationQueueOwner,
} from "./notification-intents.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
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
      snapshot: {
        defaultAgentId: currentDefaultAgentId(state),
        claims: [...params.candidates.values()].map((job) => {
          const claim = prepareCronRunReceiptClaim({
            storePath: state.deps.storePath,
            job: params.onExit ? { ...job, enabled: false } : job,
            agentId: resolveCronJobEffectiveAgentId(job, currentDefaultAgentId(state)),
            startedAtMs: params.reservedAtMs,
            requestRunId: params.requestRunId,
            observed: undefined,
          });
          claimLocalCronRunReceiptOwnership(claim.handle);
          prospective.push(claim.handle);
          return claim;
        }),
        locallyOwnedReceiptIds: listLocallyOwnedCronRunReceiptIds(),
        replacements: [...params.candidates.keys()].flatMap((jobId) => {
          const owner = state.queuedRunReservationsByJobId.get(jobId);
          return owner ? [{ ...owner.runReceipt }] : [];
        }),
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
  const context = reservation.runReceiptContext;
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
    snapshot: { markerAtMs, defaultAgentId: currentDefaultAgentId(state) },
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

type GeneralRelease = {
  policy?: undefined;
  restoreLastError?: boolean;
  recompute?: boolean;
  terminal?: CronReceiptTerminal;
  requireCurrentReceipt?: boolean;
};
type SchedulerRelease = {
  policy: Exclude<CronReservationReleasePolicy, { kind: "general" }>;
  restoreLastError?: never;
  recompute?: never;
  terminal?: never;
  requireCurrentReceipt?: never;
};

export async function releaseReservedCronRuns(
  params: {
    state: CronServiceState;
    context: OpenClawStateWorkerContext;
    reservations: readonly QueuedCronRunReservation[];
    storeKey?: string;
    nowMs?: number;
    assertCurrent?: () => void;
    onSettled: (outcome: "committed" | "not-committed" | "unknown") => void;
  } & (GeneralRelease | SchedulerRelease),
): Promise<void> {
  const { state, context } = params;
  const storeKey = params.storeKey ?? cronStoreKey(state.deps.storePath);
  const selections = params.reservations.map(({ jobId, reservationIdentity }) => ({
    jobId,
    reservationIdentity,
  }));
  const policy: CronReservationReleasePolicy = params.policy
    ? structuredClone(params.policy)
    : {
        kind: "general",
        restoreLastError: params.restoreLastError !== false,
        recompute: params.recompute === true,
        terminal: params.terminal ? structuredClone(params.terminal) : undefined,
        requireCurrentReceipt: params.requireCurrentReceipt,
      };
  const terminal = policy.kind === "general" ? policy.terminal : undefined;
  const requireCurrentReceipt = policy.kind === "general" && policy.requireCurrentReceipt;
  const retained = terminal ? retainCronRunReceiptSettlement(terminal.handle) : undefined;
  let notifications: Parameters<typeof runPostPersistCronNotifications>[1];
  try {
    await runCronRuntimeMutation({
      context,
      type: "cron.releaseReservations",
      input: {
        storeKey,
        jobIds: selections.map(({ jobId }) => jobId),
        policy,
      },
      assertCurrent() {
        params.assertCurrent?.();
        if (cronStoreKey(state.deps.storePath) !== storeKey) {
          throw new Error("Cron reservation store changed before cleanup");
        }
        retained?.assertCurrent();
        if (
          requireCurrentReceipt &&
          terminal &&
          state.deps.isAgentAvailable?.(terminal.handle.agentId, undefined, {
            deletionBlocked: false,
          }) === false
        ) {
          throw new CronRunReceiptRevisionError(
            terminal.handle.receiptId,
            describeUnavailableCronAgent(terminal.handle.agentId),
            "owner-unavailable",
          );
        }
        for (const { jobId, reservationIdentity } of selections) {
          const owner = state.queuedRunReservationsByJobId.get(jobId);
          if (owner?.identity !== reservationIdentity) {
            continue;
          }
          const admission = owner.runReceiptContext.admission;
          admission.assertCurrent();
          if (
            owner.runReceipt.storeKey !== storeKey ||
            admission.identity.key !== context.admission.identity.key ||
            admission.identity.birthtime !== context.admission.identity.birthtime
          ) {
            throw new Error("Cron reservation cleanup spans different database owners");
          }
        }
      },
      snapshot: {
        nowMs: params.nowMs ?? state.deps.nowMs(),
        defaultAgentId: policy.kind === "general" ? currentDefaultAgentId(state) : undefined,
        notificationRouting: prepareCronNotificationRouting(
          state.deps,
          [
            ...selections.map(({ jobId }) => jobId),
            ...(policy.kind === "startup-settlement"
              ? policy.deferredJobs.map(({ jobId }) => jobId)
              : []),
          ].some((jobId) => {
            const job = state.store?.jobs.find((candidate) => candidate.id === jobId);
            return job && !resolveCronNotificationQueueOwner(job, "auto-disabled").agentId;
          }),
        ).routing,
        reservations: selections.flatMap(({ jobId, reservationIdentity }) => {
          const owner = state.queuedRunReservationsByJobId.get(jobId);
          return owner?.identity === reservationIdentity
            ? [
                {
                  jobId,
                  markerAtMs: owner.markerAtMs,
                  runReceipt: { ...owner.runReceipt },
                  activationPreviousLastError: owner.activationPreviousLastError,
                },
              ]
            : [];
        }),
        deferTerminal: retained?.pending === true,
      },
      publish(committed) {
        if (terminal && retained?.pending) {
          retained.deferFinish(terminal, context);
        }
        if (committed.jobs.length > 0) {
          noteCronJobsStoreCommit(storeKey);
        }
        try {
          notifications = committed.notifications;
          applyCronRuntimeRowsToState(state, committed.jobs);
          for (const entry of committed.logs) {
            state.deps.log[entry.level](entry.fields, entry.message);
          }
        } finally {
          releaseReservationOwnership(state, selections);
        }
      },
      onSettled(outcome) {
        if (outcome === "unknown") {
          // Native work has joined; leave its receipt for recovery without another cleanup.
          releaseReservationOwnership(state, selections);
        }
        params.onSettled(outcome);
      },
    });
    await runPostPersistCronNotifications(state, notifications);
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

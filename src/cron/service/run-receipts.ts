import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isCronSelfRemovalCurrent,
  noteActiveCronJobScheduleMutation,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronStoreKey } from "../store/key.js";
import { loadedCronStoreFromRows, loadCronRows } from "../store/row-codec.js";
import {
  activateCronRunReceiptInDatabase,
  adjudicateActiveCronRunReceiptInDatabase,
  assertCronRunReceiptCurrent,
  assertCronRunReceiptCurrentInDatabase,
  assertCronRunReceiptOwnedInDatabase,
  claimCronRunReceiptInDatabase,
  CronRunReceiptRevisionError,
  finishCronRunReceipt,
  finishCronRunReceiptInDatabase,
  findActiveCronRunReceiptInDatabase,
  isCronRunReceiptSettlementPending,
  prepareCronRunReceiptAdjudication,
  prepareCronRunReceiptClaim,
  trackCronRunReceiptSettlement,
  type PreparedCronRunReceiptClaim,
  type CronRunReceiptHandle,
  type CronRunReceiptStatus,
} from "../store/run-receipt-store.js";
import { retireCronRunTriggerStateInDatabase } from "../store/run-receipt-trigger-state.js";
import type { CronStoreTransactionHooks } from "../store/transaction-hooks.types.js";
import type { CronJob, CronRunStatus } from "../types.js";
import type { CronServiceState } from "./state.js";
import { findCronTaskRunRecoveryInDatabase } from "./task-runs.js";

export type CronRunReceiptSettlementDisposition = "owner-unavailable";

function currentDefaultAgentId(state: CronServiceState): string | undefined {
  return state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId;
}

function resolveCronRunReceiptAgentId(state: CronServiceState, job: CronJob): string {
  return resolveCronJobEffectiveAgentId(job, currentDefaultAgentId(state));
}

function resolveAgentId(state: CronServiceState) {
  return (job: CronJob) => resolveCronRunReceiptAgentId(state, job);
}

export function prepareServiceCronRunReceiptClaim(params: {
  state: CronServiceState;
  job: CronJob;
  startedAtMs: number;
  requestRunId?: string;
}): PreparedCronRunReceiptClaim {
  return prepareCronRunReceiptClaim({
    storePath: params.state.deps.storePath,
    job: params.job,
    agentId: resolveCronRunReceiptAgentId(params.state, params.job),
    startedAtMs: params.startedAtMs,
    requestRunId: params.requestRunId,
  });
}

export function claimServiceCronRunReceiptInDatabase(
  state: CronServiceState,
  database: DatabaseSync,
  prepared: PreparedCronRunReceiptClaim,
): CronRunReceiptHandle {
  return claimCronRunReceiptInDatabase({
    database,
    prepared,
    resolveAgentId: resolveAgentId(state),
  });
}

export function activateServiceCronRunReceiptInDatabase(
  state: CronServiceState,
  database: DatabaseSync,
  handle: CronRunReceiptHandle,
  startedAtMs: number,
): CronRunReceiptHandle {
  return activateCronRunReceiptInDatabase({
    database,
    handle,
    startedAtMs,
    resolveAgentId: resolveAgentId(state),
  });
}

function cronRunReceiptOwnerMutationHooks(params: {
  state: CronServiceState;
  jobId: string;
}): CronStoreTransactionHooks {
  const prepared = prepareCronRunReceiptAdjudication({
    storePath: params.state.deps.storePath,
    jobId: params.jobId,
    nowMs: params.state.deps.nowMs(),
  });
  return {
    beforeWrite: (database) => {
      // Admission and owner mutation share SQLite's write order: whichever
      // commits first fences the other, closing the pre-dispatch side-effect gap.
      adjudicateActiveCronRunReceiptInDatabase({
        database,
        jobId: params.jobId,
        prepared,
        finishedAtMs: params.state.deps.nowMs(),
      });
    },
  };
}

export function cronRunReceiptMutationHooks(params: {
  state: CronServiceState;
  jobId: string;
  ownerChanged: boolean;
  triggerStateChanged: boolean;
  scheduleChangedJob?: CronJob;
}): CronStoreTransactionHooks | undefined {
  const ownerHooks = params.ownerChanged ? cronRunReceiptOwnerMutationHooks(params) : undefined;
  if (!ownerHooks && !params.triggerStateChanged && !params.scheduleChangedJob) {
    return undefined;
  }
  return {
    ...ownerHooks,
    beforeWrite: (database) => {
      if (params.scheduleChangedJob) {
        const current = loadedCronStoreFromRows(
          loadCronRows(
            database,
            cronStoreKey(params.state.deps.storePath),
            new Set([params.jobId]),
          ),
        ).store.jobs[0];
        if (current?.state.runningAtMs !== undefined) {
          // A fresh nonce makes every committed edit a distinct state delta,
          // even if a passive editor observed a retired run that has since ended.
          params.scheduleChangedJob.state.runningScheduleChangeId = randomUUID();
        } else {
          delete params.scheduleChangedJob.state.runningScheduleChangeId;
        }
      }
      if (params.triggerStateChanged) {
        retireServiceCronRunTriggerStateInDatabase({ ...params, database });
      }
      ownerHooks?.beforeWrite?.(database);
    },
    afterCommit: () => {
      ownerHooks?.afterCommit?.();
      if (params.scheduleChangedJob) {
        // Retire live ownership with the durable edit, never on a failed write.
        noteActiveCronJobScheduleMutation(params.jobId);
      }
    },
  };
}

function retireServiceCronRunTriggerStateInDatabase(params: {
  state: CronServiceState;
  database: DatabaseSync;
  jobId: string;
}): void {
  const { database, jobId } = params;
  const storePath = params.state.deps.storePath;
  const active = findActiveCronRunReceiptInDatabase({ database, storePath, jobId });
  if (active) {
    retireCronRunTriggerStateInDatabase({ database, handle: active });
    return;
  }
  const storeKey = cronStoreKey(storePath);
  const job = loadedCronStoreFromRows(loadCronRows(database, storeKey, new Set([jobId]))).store
    .jobs[0];
  const startedAtMs = job?.state.runningAtMs;
  if (!job || startedAtMs === undefined) {
    return;
  }
  // Owner edits close execution authority before scheduler reconciliation.
  // Only legacy markers without a receipt association need task-history fallback.
  const receiptId =
    job.state.runningReceiptId ??
    findCronTaskRunRecoveryInDatabase({
      database,
      jobId,
      storeKey,
      startedAt: startedAtMs,
    }).receiptId;
  if (receiptId) {
    retireCronRunTriggerStateInDatabase({
      database,
      handle: { receiptId, storeKey, jobId, startedAtMs },
    });
  }
}

export function assertServiceCronRunReceiptCurrent(
  state: CronServiceState,
  handle: CronRunReceiptHandle,
  activeJobMarker?: CronActiveJobMarker,
): void {
  assertCronRunReceiptCurrent({
    handle,
    resolveAgentId: resolveAgentId(state),
    isAgentAvailable: state.deps.isAgentAvailable,
    allowMissingJob:
      activeJobMarker?.jobId === handle.jobId && isCronSelfRemovalCurrent(activeJobMarker),
  });
}

export function resolveCronRunReceiptTerminalStatus(
  status: CronRunStatus,
  triggerFired?: boolean,
): Exclude<CronRunReceiptStatus, "running"> {
  if (status === "ok") {
    return triggerFired === false ? "skipped" : "ok";
  }
  return status === "skipped" ? "skipped" : "error";
}

function logReceiptFinishError(
  state: CronServiceState,
  handle: CronRunReceiptHandle,
  error: unknown,
) {
  state.deps.log.warn(
    { jobId: handle.jobId, err: String(error) },
    "cron: failed to finalize run receipt after execution settlement",
  );
}

function finishReceiptAfterCommit(
  state: CronServiceState,
  terminal: Parameters<typeof finishCronRunReceipt>[0],
): undefined {
  try {
    finishCronRunReceipt(terminal);
  } catch (error) {
    logReceiptFinishError(state, terminal.handle, error);
  }
}

export function trackServiceCronRunReceiptSettlement(params: {
  state: CronServiceState;
  handle: CronRunReceiptHandle;
  settlement: Promise<unknown>;
}): void {
  trackCronRunReceiptSettlement({
    handle: params.handle,
    settlement: params.settlement,
    onFinishError: (error) => logReceiptFinishError(params.state, params.handle, error),
  });
}

export function cronRunReceiptPersistHooks(params: {
  state: CronServiceState;
  handle: CronRunReceiptHandle;
  allowMissingJob?: boolean;
  terminal?: {
    status: CronRunStatus;
    triggerFired?: boolean;
    finishedAtMs: number;
    error?: string;
    disposition?: CronRunReceiptSettlementDisposition;
  };
}): CronStoreTransactionHooks {
  const terminal = params.terminal
    ? {
        handle: params.handle,
        status: resolveCronRunReceiptTerminalStatus(
          params.terminal.status,
          params.terminal.triggerFired,
        ),
        finishedAtMs: params.terminal.finishedAtMs,
        error: params.terminal.error,
      }
    : undefined;
  const deferTerminal = terminal && isCronRunReceiptSettlementPending(params.handle);
  return {
    beforeWrite: (database) => {
      const unavailableError = describeUnavailableCronAgent(params.handle.agentId);
      const recordsUnavailableGuard =
        terminal?.status === "error" && params.terminal?.disposition === "owner-unavailable";
      if (
        params.state.deps.isAgentAvailable?.(params.handle.agentId) === false &&
        !recordsUnavailableGuard
      ) {
        throw new CronRunReceiptRevisionError(
          params.handle.receiptId,
          unavailableError,
          "owner-unavailable",
        );
      }
      if (params.allowMissingJob) {
        assertCronRunReceiptOwnedInDatabase({ database, handle: params.handle });
      } else {
        assertCronRunReceiptCurrentInDatabase({
          database,
          handle: params.handle,
          resolveAgentId: resolveAgentId(params.state),
        });
      }
    },
    ...(terminal && !deferTerminal
      ? {
          afterWrite: (
            database: Parameters<NonNullable<CronStoreTransactionHooks["afterWrite"]>>[0],
          ) => {
            finishCronRunReceiptInDatabase({
              database,
              ...terminal,
            });
          },
        }
      : {}),
    ...(terminal && deferTerminal
      ? { afterCommit: () => finishReceiptAfterCommit(params.state, terminal) }
      : {}),
  };
}

export function cronRunReceiptSupersedeHooks(params: {
  state: CronServiceState;
  handle: CronRunReceiptHandle;
  finishedAtMs: number;
  error: string;
}): CronStoreTransactionHooks {
  const terminal = {
    handle: params.handle,
    status: "superseded" as const,
    finishedAtMs: params.finishedAtMs,
    error: params.error,
  };
  if (isCronRunReceiptSettlementPending(params.handle)) {
    return { afterCommit: () => finishReceiptAfterCommit(params.state, terminal) };
  }
  return {
    afterWrite: (database) => {
      finishCronRunReceiptInDatabase({
        database,
        ...terminal,
      });
    },
  };
}

export function supersedeServiceCronRunReceipt(
  handle: CronRunReceiptHandle,
  finishedAtMs: number,
  error: string,
): void {
  finishCronRunReceipt({
    handle,
    status: "superseded",
    finishedAtMs,
    error,
  });
}

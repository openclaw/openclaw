import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  isCronSelfRemovalCurrent,
  markCronJobActive,
  noteActiveCronJobMessageActionAuthorityMutation,
  noteActiveCronJobMessageSourceAuthorityMutation,
  noteActiveCronJobScheduleMutation,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronStoreKey } from "../store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "../store/row-codec.js";
import {
  adjudicateActiveCronRunReceiptInDatabase,
  assertCronRunReceiptCurrent,
  CronRunReceiptRevisionError,
  findActiveCronRunReceiptInDatabase,
  prepareCronRunReceiptAdjudication,
  readCronRunReceiptCurrentJob,
  trackCronRunReceiptSettlement,
} from "../store/run-receipt-store.js";
import { retireCronRunTriggerStateInDatabase } from "../store/run-receipt-trigger-state.js";
import type {
  CronRunReceiptHandle,
  CronRunReceiptOwnerObservation,
  CronRunReceiptStatus,
} from "../store/run-receipt.types.js";
import type { CronStoreTransactionHooks } from "../store/transaction-hooks.types.js";
import type { CronJob, CronRunStatus, CronStoredJob } from "../types.js";
import { isJobEnabled } from "./jobs-scheduling.js";
import {
  resolveCronJobMessageActionAuthorityInputs,
  resolveCronJobMessageToolAuthorityInputs,
} from "./jobs-tool-policy.js";
import { findCronRunRecoveryInDatabase } from "./run-history-recovery.js";
import type { CronServiceState } from "./state.js";
import { runsDetachedFromMainSession } from "./timer-execution-timeout.js";

function resolveCronRunReceiptAgentId(state: CronServiceState, job: CronJob): string {
  return resolveCronJobEffectiveAgentId(
    job,
    state.deps.resolveDefaultAgentId
      ? state.deps.resolveDefaultAgentId()
      : state.deps.defaultAgentId,
  );
}

/** Only receipt facts cross the reader boundary; liveness and claims stay with their owners. */
async function observeServiceCronRunReceipts(state: CronServiceState, jobIds: readonly string[]) {
  const context = captureOpenClawStateReadWorkerContext();
  const storeKey = cronStoreKey(state.deps.storePath);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (
      resolveOpenClawStateSqlitePath() !== context.admission.databasePath ||
      cronStoreKey(state.deps.storePath) !== storeKey
    ) {
      throw new Error("Cron receipt source changed during observation");
    }
  };
  const command = {
    type: "cron.observeRunRecovery" as const,
    storeKey,
    proposals: jobIds.map((jobId) => ({ jobId })),
  };
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    command,
    { context, current: true },
  );
  assertCurrent();
  if (result && (!result.ok || result.type !== command.type)) {
    throw new Error("Cron receipt observation did not return its admitted snapshot");
  }
  const receipts = new Map<string, CronRunReceiptOwnerObservation>();
  if (result?.ok && result.type === command.type && result.observation.kind === "observed") {
    for (const proposal of result.observation.proposals) {
      if (proposal.receipt) {
        receipts.set(proposal.jobId, proposal.receipt);
      }
    }
  }
  return { receipts, assertCurrent };
}

/** Both admission paths bind message permissions from the same canonical occurrence. */
export function markServiceCronJobActive(
  state: CronServiceState,
  job: CronJob,
  runReceipt: CronRunReceiptHandle,
): CronActiveJobMarker | undefined {
  return markCronJobActive(job.id, {
    agentId: runReceipt.agentId,
    declarationKey: job.declarationKey,
    preserveAcrossGenerationAdvance: !runsDetachedFromMainSession(job),
    isMessageActionAuthorityCurrent: createServiceCronRunMessageAuthorityChecker({
      state,
      job,
      handle: runReceipt,
      resolveInputs: resolveCronJobMessageToolAuthorityInputs,
    }),
    isMessageSourceAuthorityCurrent: createServiceCronRunMessageAuthorityChecker({
      state,
      job,
      handle: runReceipt,
      resolveInputs: resolveCronJobMessageActionAuthorityInputs,
    }),
  });
}

/** Retains admission's permission facts while consulting the existing canonical receipt owner. */
function createServiceCronRunMessageAuthorityChecker(params: {
  state: CronServiceState;
  job: CronStoredJob;
  handle: CronRunReceiptHandle;
  resolveInputs: (job: CronStoredJob) => unknown;
}): (() => boolean) | undefined {
  const expected = params.resolveInputs(params.job);
  if (!expected) {
    return undefined;
  }
  const { state, handle } = params;
  const admittedEnabled = isJobEnabled(params.job);
  return () => {
    let current: CronJob | undefined;
    try {
      current = readCronRunReceiptCurrentJob({
        handle,
        resolveAgentId: (job) => resolveCronRunReceiptAgentId(state, job),
        isAgentAvailable: state.deps.isAgentAvailable,
      });
    } catch (error) {
      if (error instanceof CronRunReceiptRevisionError) {
        return false;
      }
      throw error;
    }
    // A force run may start disabled; a later disable still retires an enabled admission.
    return (
      current !== undefined &&
      (!admittedEnabled || isJobEnabled(current)) &&
      isDeepStrictEqual(expected, params.resolveInputs(current))
    );
  };
}

export function prepareCronRunReceiptOwnerMutationHooks(params: {
  state: CronServiceState;
  previousJob: CronJob;
  nextJob: CronJob;
}): Promise<CronStoreTransactionHooks> | undefined {
  const { state, previousJob, nextJob } = params;
  const previousAgentId = resolveCronRunReceiptAgentId(state, previousJob);
  const nextAgentId = resolveCronRunReceiptAgentId(state, nextJob);
  if (previousAgentId === nextAgentId) {
    return undefined;
  }
  const generation = state.lifecycleGeneration;
  return observeServiceCronRunReceipts(state, [nextJob.id]).then((observation) => {
    const assertCurrent = () => {
      observation.assertCurrent();
      if (
        state.lifecycleGeneration !== generation ||
        resolveCronRunReceiptAgentId(state, previousJob) !== previousAgentId ||
        resolveCronRunReceiptAgentId(state, nextJob) !== nextAgentId
      ) {
        throw new Error("Cron service or owner changed during receipt observation");
      }
    };
    assertCurrent();
    const prepared = prepareCronRunReceiptAdjudication({
      storePath: state.deps.storePath,
      observed: observation.receipts.get(nextJob.id),
      nowMs: state.deps.nowMs(),
    });
    return {
      beforeWrite: (database) => {
        assertCurrent();
        // Admission and owner mutation share SQLite's write order: whichever
        // commits first fences the other, closing the pre-dispatch side-effect gap.
        adjudicateActiveCronRunReceiptInDatabase({
          database,
          jobId: nextJob.id,
          prepared,
          finishedAtMs: state.deps.nowMs(),
        });
      },
    };
  });
}

export function cronRunReceiptMutationHooks(params: {
  state: CronServiceState;
  jobId: string;
  ownerHooks?: CronStoreTransactionHooks;
  triggerStateChanged: boolean;
  messageActionAuthorityChanged?: boolean;
  messageSourceAuthorityChanged?: boolean;
  scheduleChangedJob?: CronJob;
}): CronStoreTransactionHooks | undefined {
  const { ownerHooks } = params;
  if (
    !ownerHooks &&
    !params.triggerStateChanged &&
    !params.scheduleChangedJob &&
    !params.messageActionAuthorityChanged &&
    !params.messageSourceAuthorityChanged
  ) {
    return undefined;
  }
  return {
    ...ownerHooks,
    beforeWrite: (database, receiptSchema) => {
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
      ownerHooks?.beforeWrite?.(database, receiptSchema);
    },
    afterCommit: () => {
      ownerHooks?.afterCommit?.();
      if (params.messageActionAuthorityChanged) {
        noteActiveCronJobMessageActionAuthorityMutation(params.jobId);
      }
      if (params.messageSourceAuthorityChanged) {
        noteActiveCronJobMessageSourceAuthorityMutation(params.jobId);
      }
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
  // Only legacy markers without a receipt association need history fallback.
  const receiptId =
    job.state.runningReceiptId ??
    findCronRunRecoveryInDatabase({
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
    resolveAgentId: (job) => resolveCronRunReceiptAgentId(state, job),
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

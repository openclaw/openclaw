import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  isCronSelfRemovalCurrent,
  isCronActiveJobMarkerCurrent,
  markCronJobActive,
  noteActiveCronJobMessageActionAuthorityMutation,
  noteActiveCronJobMessageSourceAuthorityMutation,
  noteActiveCronJobScheduleMutation,
  onCronJobInactive,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronStoreKey } from "../store/key.js";
import { projectCronReceiptAuthorityJobFacts } from "../store/receipt-authority-facts.js";
import { observeCronReceiptAuthority } from "../store/receipt-authority-owner.js";
import {
  CronRunReceiptRevisionError,
  prepareCronRunReceiptAdjudication,
  assertCronRunReceiptCurrentFacts,
  trackCronRunReceiptSettlement,
} from "../store/run-receipt-store.js";
import type {
  CronRunReceiptCurrentFacts,
  CronRunReceiptHandle,
  CronRunReceiptCurrentReadCommand,
  CronRunReceiptOwnerObservation,
  CronRunReceiptStatus,
  PreparedCronRunReceiptAdjudication,
} from "../store/run-receipt.types.js";
import type { CronAgentScope } from "../types-shared.js";
import type { CronJob, CronRunStatus } from "../types.js";
import type { CronServiceState } from "./state.js";
import { runsDetachedFromMainSession } from "./timer-execution-timeout.js";

function resolveCronRunReceiptAgentId(state: CronServiceState, job: CronAgentScope): string {
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
  const context = captureOpenClawStateWorkerContext();
  const facts = {
    receipt: runReceipt,
    job: projectCronReceiptAuthorityJobFacts(job),
    deletionBlocked: false,
  };
  const observation = observeCronReceiptAuthority(
    context,
    {
      type: "cron.currentReceipt",
      handle: runReceipt,
      includeJob: true,
      includeAvailability: true,
    },
    facts,
  );
  const assertFacts = (current: CronRunReceiptCurrentFacts) =>
    assertCronRunReceiptCurrentFacts({
      handle: runReceipt,
      facts: current,
      resolveAgentId: (currentJob) => resolveCronRunReceiptAgentId(state, currentJob),
      isAgentAvailable: state.deps.isAgentAvailable,
      env: context.environment,
    });
  const isCurrent = (sourceSensitive: boolean) => () => {
    const current = observation.readForPreparation();
    try {
      assertFacts(current.facts);
    } catch (error) {
      if (error instanceof CronRunReceiptRevisionError) {
        return false;
      }
      throw error;
    }
    return !(sourceSensitive ? current.sourceRevoked : current.messageRevoked);
  };
  const marker = markCronJobActive(job.id, {
    agentId: runReceipt.agentId,
    stateIdentityKey: context.admission.identity.key,
    declarationKey: job.declarationKey,
    preserveAcrossGenerationAdvance: !runsDetachedFromMainSession(job),
    isMessageActionAuthorityCurrent: facts.job.messageToolAuthorityInputs
      ? isCurrent(false)
      : undefined,
    isMessageSourceAuthorityCurrent: facts.job.messageActionAuthorityInputs
      ? isCurrent(true)
      : undefined,
    prepareMessageUse: (sourceSensitive, assertCurrent, signal) =>
      observation.acquireUse({
        permission: sourceSensitive ? "source" : "message",
        signal,
        assertCurrent(current) {
          assertCurrent();
          assertFacts(current);
        },
      }),
  });
  if (marker) {
    marker.standingGrantAuthority = {
      context,
      handle: { ...runReceipt },
      assertCurrent() {
        context.admission.assertCurrent();
        if (
          resolveCronRunReceiptAgentId(state, job) !== runReceipt.agentId ||
          state.deps.isAgentAvailable?.(runReceipt.agentId, undefined, {
            deletionBlocked: false,
          }) === false
        ) {
          throw new CronRunReceiptRevisionError(runReceipt.receiptId, "cron owner changed");
        }
      },
      acquireUse: (assertCurrent, signal) =>
        observation.acquireUse({
          permission: "execution",
          assertCurrent,
          signal,
        }),
    };
  }
  onCronJobInactive(marker, () => observation.release());
  return marker;
}

export type CronRunReceiptOwnerMutation = {
  prepared: PreparedCronRunReceiptAdjudication;
  assertCurrent: () => void;
};

export function prepareCronRunReceiptOwnerMutation(params: {
  state: CronServiceState;
  previousJob: CronJob;
  nextJob: CronJob;
}): Promise<CronRunReceiptOwnerMutation> | undefined {
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
    return { prepared, assertCurrent };
  });
}

export function publishCronRunReceiptMutation(params: {
  jobId: string;
  messageActionAuthorityChanged?: boolean;
  messageSourceAuthorityChanged?: boolean;
  scheduleChanged: boolean;
}): void {
  if (params.messageActionAuthorityChanged) {
    noteActiveCronJobMessageActionAuthorityMutation(params.jobId);
  }
  if (params.messageSourceAuthorityChanged) {
    noteActiveCronJobMessageSourceAuthorityMutation(params.jobId);
  }
  if (params.scheduleChanged) {
    noteActiveCronJobScheduleMutation(params.jobId);
  }
}

export async function assertServiceCronRunReceiptCurrent(
  state: CronServiceState,
  originalHandle: CronRunReceiptHandle,
  activeJobMarker: CronActiveJobMarker | undefined,
  context: OpenClawStateWorkerContext,
  signal?: AbortSignal,
): Promise<void> {
  const handle = { ...originalHandle };
  const isAgentAvailable = state.deps.isAgentAvailable;
  const allowMissingJob = () =>
    activeJobMarker?.jobId === handle.jobId && isCronSelfRemovalCurrent(activeJobMarker);
  const command: CronRunReceiptCurrentReadCommand = {
    type: "cron.currentReceipt",
    handle,
    includeJob: !allowMissingJob(),
    includeAvailability: isAgentAvailable !== undefined,
  };
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    command,
    { context, current: true, signal },
  );
  context.admission.assertCurrent();
  signal?.throwIfAborted();
  // Main-session runs can retain a removal request without a bound abort controller.
  if (activeJobMarker?.cancellation?.kind === "requested") {
    throw new CronRunReceiptRevisionError(handle.receiptId, activeJobMarker.cancellation.reason);
  }
  if (!isCronActiveJobMarkerCurrent(activeJobMarker)) {
    throw new CronRunReceiptRevisionError(handle.receiptId, "cron run fence is no longer current");
  }
  if (result && (!result.ok || result.type !== command.type)) {
    throw new Error("Cron current receipt read did not return its admitted snapshot");
  }
  assertCronRunReceiptCurrentFacts({
    handle,
    facts: result?.ok && result.type === command.type ? result.facts : undefined,
    resolveAgentId: (job) => resolveCronRunReceiptAgentId(state, job),
    isAgentAvailable,
    allowMissingJob: allowMissingJob(),
    env: context.environment,
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

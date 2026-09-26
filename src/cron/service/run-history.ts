/** Cron receipts own running work; history records only durable outcomes. */
import { randomUUID } from "node:crypto";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { createExecutionStartedOwnerBinding } from "../../audit/execution-owner-binding.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronRunLogEntryFromEvent } from "../run-event-codec.js";
import {
  cronQuietTriggerDetail,
  cronRunLogEntryToDetail,
  cronRunStorageStatus,
} from "../run-history-detail.js";
import { createCronExecutionId } from "../run-id.js";
import { cronStoreKey } from "../store/key.js";
import { recordCronRun } from "../store/run-history.js";
import type { CronRunHistoryWrite } from "../store/run-history.types.js";
import { bindCronRunReceiptExecution } from "../store/run-receipt-execution-binding.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronCompletionStatus, CronJob, CronRunErrorClassification } from "../types.js";
import type { CronEvent, CronExecutionIdentityAdmission, CronServiceState } from "./state.js";

/** Carries exact admission into the first post-admission owner lifecycle phase. */
export function createCronOwnerExecutionIdentityAdmission(params: {
  state: CronServiceState;
  runReceipt: CronRunReceiptHandle;
}): CronExecutionIdentityAdmission {
  const ownerBinding = createExecutionStartedOwnerBinding(async (admitted) => {
    try {
      if (!admitted.executionIdentityToken) {
        return;
      }
      const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
      if (!assertCurrent) {
        throw new Error("Cron execution authority closed before owner binding");
      }
      const context = captureOpenClawStateWorkerContext();
      const receiptResult = await bindCronRunReceiptExecution({
        admitted,
        handle: params.runReceipt,
        context,
        assertCurrent,
      });
      if (receiptResult === "mismatch" || receiptResult === "missing") {
        params.state.deps.log.warn(
          { receiptResult },
          "cron: exact execution identity binding was not retained",
        );
      }
    } catch (error) {
      params.state.deps.log.warn(
        { error },
        "cron: failed to retain exact execution identity binding",
      );
    }
  });
  return {
    ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
    onPostAdmission: ownerBinding.onPostAdmission,
    onExecutionStarted: ownerBinding.onExecutionStarted,
  };
}

function createCronHistoryRunId(
  jobId: string,
  startedAt: number,
  receiptId?: string,
  publicRunId?: string,
): string {
  const receipt = receiptId?.trim();
  const publicId = publicRunId?.trim();
  const discriminator = receipt || publicId || randomUUID();
  const publicSuffix = publicId && publicId !== discriminator ? `:${publicId}` : "";
  return `${createCronExecutionId(jobId, startedAt)}:${discriminator}${publicSuffix}`;
}

export function createCronRunHandle(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
  runReceipt?: CronRunReceiptHandle;
  publicRunId?: string;
}): { runId: string } {
  return {
    runId: createCronHistoryRunId(
      params.job.id,
      params.startedAt,
      params.runReceipt?.receiptId,
      params.publicRunId,
    ),
  };
}

/** Quiet evaluations retain recovery state without appearing in cron.runs. */
export async function recordQuietCronEvaluation(
  state: CronServiceState,
  result: {
    taskRunId?: string;
    status: "ok" | "error" | "skipped";
    completionStatus?: CronCompletionStatus;
    error?: unknown;
    endedAt: number;
    summary?: string;
    childSessionKey?: string;
    sessionKey?: string;
    jobId?: string;
    startedAt?: number;
    job?: CronJob;
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown };
  },
): Promise<void> {
  if (!result.taskRunId || result.triggerEval?.fired !== false) {
    return;
  }
  if (!result.jobId || result.startedAt === undefined) {
    throw new Error("Quiet cron outcome has no execution identity");
  }
  const storeKey = cronStoreKey(state.deps.storePath);
  await persistCronOutcome(state, {
    storeKey,
    jobId: result.jobId,
    runId: result.taskRunId,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    agentId: result.job
      ? tryResolveCronJobEffectiveAgentId(
          result.job,
          state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
        )
      : undefined,
    sessionKey: result.childSessionKey ?? result.sessionKey,
    status: "succeeded",
    detail: cronQuietTriggerDetail(storeKey, { ...result.triggerEval, fired: false }),
  });
}

/** Join history persistence before settlement; a storage failure cannot strand a running receipt. */
export async function finishCronRun(
  state: CronServiceState,
  result: {
    taskRunId?: string;
    job?: CronJob;
    event: CronEvent & { action: "finished" };
    ownerlessRun?: true;
    errorClassification?: CronRunErrorClassification;
    scriptResult?: { scriptStateChanged?: boolean; scriptState?: unknown };
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown };
  },
): Promise<void> {
  const entry = cronRunLogEntryFromEvent(
    result.event,
    state.deps.nowMs(),
    result.errorClassification,
  );
  const startedAt = entry.runAtMs ?? entry.ts;
  const job = result.job ?? result.event.job;
  const storeKey = cronStoreKey(state.deps.storePath);
  await persistCronOutcome(state, {
    storeKey,
    jobId: entry.jobId,
    runId:
      result.taskRunId ?? createCronHistoryRunId(entry.jobId, startedAt, undefined, entry.runId),
    agentId:
      !result.ownerlessRun && job
        ? tryResolveCronJobEffectiveAgentId(
            job,
            state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
          )
        : undefined,
    startedAt,
    endedAt: entry.ts,
    status: cronRunStorageStatus(entry),
    sessionKey: entry.sessionKey,
    error: entry.error,
    summary: entry.summary,
    detail: cronRunLogEntryToDetail(entry, {
      storeKey,
      scriptResult: result.scriptResult,
      triggerEval: result.triggerEval,
    }),
  });
}

async function persistCronOutcome(
  state: CronServiceState,
  input: CronRunHistoryWrite,
): Promise<void> {
  try {
    await recordCronRun(input);
  } catch (error) {
    state.deps.log.warn(
      { jobId: input.jobId, runId: input.runId, error },
      "cron: failed to persist run history",
    );
  }
}

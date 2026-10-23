/** Cron receipts own running work; history records only durable outcomes. */
import { randomUUID } from "node:crypto";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronRunLogEntryFromEvent } from "../run-event-codec.js";
import { cronRunLogEntryToDetail, cronRunStorageStatus } from "../run-history-detail.js";
import { createCronExecutionId } from "../run-id.js";
import { cronStoreKey } from "../store/key.js";
import { recordCronRun, type CronRunHistorySource } from "../store/run-history.js";
import type { CronRunHistoryWrite } from "../store/run-history.types.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronEvent, CronJob, CronRunErrorClassification } from "../types.js";
import type { CronServiceState } from "./state.js";

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

/** Join history persistence before settlement; a storage failure cannot strand a running receipt. */
export async function finishCronRun(
  state: CronServiceState,
  result: {
    taskRunId?: string;
    historySource?: CronRunHistorySource;
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
  const source = result.historySource;
  const storeKey = source?.storeKey ?? cronStoreKey(state.deps.storePath);
  await persistCronOutcome(
    state,
    {
      storeKey,
      jobId: entry.jobId,
      runId:
        result.taskRunId ?? createCronHistoryRunId(entry.jobId, startedAt, undefined, entry.runId),
      agentId:
        !result.ownerlessRun && job
          ? tryResolveCronJobEffectiveAgentId(
              job,
              source
                ? source.defaultAgentId
                : (state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId),
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
    },
    source,
  );
}

async function persistCronOutcome(
  state: CronServiceState,
  input: CronRunHistoryWrite,
  source?: CronRunHistorySource,
): Promise<void> {
  try {
    await recordCronRun(input, source);
  } catch (error) {
    state.deps.log.warn(
      { jobId: input.jobId, runId: input.runId, error },
      "cron: failed to persist run history",
    );
  }
}

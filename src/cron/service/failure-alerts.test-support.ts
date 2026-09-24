import { vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { markCronJobActive } from "../active-jobs.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { createCronServiceState } from "./state.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { authorCronRunCompletion } from "./timer.js";

export type SendCronFailureAlert = NonNullable<
  Parameters<typeof createCronServiceState>[0]["sendCronFailureAlert"]
>;

export function createAlertJob(params: {
  id: string;
  dueAt: number;
  includeSkipped?: boolean;
}): CronJob {
  const job = createDueIsolatedJob({
    id: params.id,
    nowMs: params.dueAt,
    nextRunAtMs: params.dueAt,
  });
  job.schedule = { kind: "every", everyMs: 60_000, anchorMs: params.dueAt - 60_000 };
  job.failureAlert = {
    after: 1,
    cooldownMs: 60_000,
    ...(params.includeSkipped ? { includeSkipped: true } : {}),
  };
  job.state.runningAtMs = params.dueAt;
  return job;
}

export function createAlertState(params: {
  storePath: string;
  nowMs: () => number;
  sendCronFailureAlert: SendCronFailureAlert;
}) {
  return createCronRegressionState({
    storePath: params.storePath,
    nowMs: params.nowMs,
    sendCronFailureAlert: params.sendCronFailureAlert,
    runIsolatedAgentJob: vi.fn(),
  });
}

export async function finalizeAlertOutcome(params: {
  state: ReturnType<typeof createCronServiceState>;
  job: CronJob;
  status: CronRunStatus;
  error?: string;
  startedAt: number;
  endedAt: number;
}) {
  await finalizeCompletedCronRunOutcomes(params.state, [
    {
      jobId: params.job.id,
      job: structuredClone(params.job),
      activeJobMarker: markCronJobActive(params.job.id),
      ...authorCronRunCompletion(params.state, params.job, {
        status: params.status,
        error: params.error,
      }),
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    },
  ]);
}

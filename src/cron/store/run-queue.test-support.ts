import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations as Operations } from "../../state/openclaw-state-worker-contract.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { currentPluginCommandHostProcessId } from "../plugin-command-schedule.js";
import type { PluginCommandScheduleHost } from "../plugin-command-schedule.types.js";
import { projectCronRunHistoryPage } from "../run-history.js";
import { saveCronStore } from "../store.js";
import type { CronJob, CronJobPatch } from "../types.js";
import { readCronRunHistoryCandidates, readCronRunHistoryRecords } from "./read-only.js";
import type {
  CronRunQueueOperations,
  CronRunRequestContext as RequestContext,
} from "./run-queue.types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";
import { createCronScheduledRunId } from "./run-request-id.js";

export type QueueRequest = CronRunQueueOperations["cron.requestRuns"]["input"]["requests"][number];
export function requestFor(
  current: CronJob,
  input: Omit<QueueRequest, "jobId" | "configRevision">,
): QueueRequest {
  return { jobId: current.id, configRevision: resolveCronJobConfigRevision(current), ...input };
}
export function scheduled(storeKey: string, current: CronJob, now: number) {
  return requestFor(current, {
    receiptId: createCronScheduledRunId(storeKey, current.id, now),
    scheduledSlotMs: now,
    mode: "scheduled",
  });
}
export function requestForJob(storeKey: string, current: CronJob, now: number) {
  return current.schedule.kind === "on-exit"
    ? requestFor(current, {
        receiptId: "cron:request:exit",
        mode: "on-exit",
        onExitSchedule: current.schedule,
      })
    : scheduled(storeKey, current, now);
}
export function queueJob(id: string, now: number, overrides: Partial<CronJob> = {}): CronJob {
  return makeCronJob({
    id,
    name: id,
    agentId: "main",
    createdAtMs: now - 1000,
    updatedAtMs: now - 1000,
    payload: { kind: "command", argv: ["echo", id] },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now },
    ...overrides,
  });
}

export async function queueStore(
  storeKey: string,
  jobs: CronJob[],
  now: number,
  getContext = captureOpenClawStateWorkerContext,
) {
  await saveCronStore(storeKey, { version: 1, jobs });
  const run = <Key extends keyof Operations>(type: Key, input: Operations[Key]["input"]) =>
    executeOpenClawStateWorker(getContext(), { type, input });
  const mutate = (jobMutation: Operations["cron.mutateJobs"]["input"]["jobMutation"]) =>
    run("cron.mutateJobs", { storeKey, jobMutation, snapshot: { nowMs: now + 1 } });
  return {
    storeKey,
    read: async () => {
      const result = await run("cron.loadMutable", { storeKey });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.loaded.store;
    },
    history: async (runId?: string) => {
      const { records } = await readCronRunHistoryCandidates(storeKey);
      const history = await readCronRunHistoryRecords(
        storeKey,
        records.map(({ id }) => id),
      );
      return projectCronRunHistoryPage(history, { storeKey, runId });
    },
    recover: () => run("cron.recoverRuns", { storeKey, nowMs: now + 2 }),
    readReceipt: async (handle: CronRunReceiptHandle) => {
      const context = getContext();
      const result = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        { type: "cron.currentReceipt", handle, includeJob: false, includeAvailability: false },
        { context },
      );
      if (!result) {
        throw new Error("Cron receipt read failed");
      }
      return result.facts.receipt;
    },
    request: (requests: QueueRequest[], nowMs = now) =>
      run("cron.requestRuns", { storeKey, nowMs, requests }),
    drain: (
      requests: RequestContext[] = [],
      maxConcurrentRuns = 1,
      schedulingPaused = false,
      pluginCommandHosts?: PluginCommandScheduleHost[],
    ) =>
      run("cron.drainQueue", {
        storeKey,
        nowMs: now + 1,
        requests,
        maxConcurrentRuns,
        schedulingPaused,
        hostProcessId: currentPluginCommandHostProcessId(),
        pluginCommandHosts,
      }),
    cancel: (receiptIds: string[], status?: "skipped" | "superseded") =>
      run("cron.cancelRequests", {
        storeKey,
        receiptIds,
        nowMs: now + 2,
        reason: "synthetic cancellation",
        status,
      }),
    update: (id: string, patch: CronJobPatch) =>
      mutate({ kind: "update", id, patch, options: { captured: false } }),
    remove: (id: string) => mutate({ kind: "remove", ids: [id] }),
  };
}

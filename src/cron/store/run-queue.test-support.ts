import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations as Operations } from "../../state/openclaw-state-worker-contract.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { projectCronRunHistoryPage } from "../run-history.js";
import { saveCronStore } from "../store.js";
import type { CronJob, CronJobPatch } from "../types.js";
import { readCronRunHistoryCandidates, readCronRunHistoryRecords } from "./read-only.js";
import type { CronRunQueueOperations, CronRunRequestContext } from "./run-queue.types.js";
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
async function readHistoryRecords(storeKey: string) {
  const { records } = await readCronRunHistoryCandidates(storeKey);
  return readCronRunHistoryRecords(
    storeKey,
    records.map((record) => record.id),
  );
}

export function queueJob(id: string, now: number, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: now - 1000,
    updatedAtMs: now - 1000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["echo", id] },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now },
    ...overrides,
  };
}

export async function queueStore(
  storeKey: string,
  jobs: CronJob[],
  now: number,
  getContext: () => OpenClawStateWorkerContext = captureOpenClawStateWorkerContext,
) {
  await saveCronStore(storeKey, { version: 1, jobs });
  const run = <Key extends keyof Operations>(type: Key, input: Operations[Key]["input"]) =>
    executeOpenClawStateWorker(getContext(), { type, input });
  const mutate = (jobMutation: Operations["cron.mutateJobs"]["input"]["jobMutation"]) =>
    run("cron.mutateJobs", { storeKey, jobMutation, snapshot: { nowMs: now + 1 } });
  const read = async () => {
    const result = await run("cron.loadMutable", { storeKey });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.loaded.store;
  };
  return {
    storeKey,
    read,
    history: async (runId?: string) =>
      projectCronRunHistoryPage(await readHistoryRecords(storeKey), { storeKey, runId }),
    recover: () => run("cron.recoverRuns", { storeKey, nowMs: now + 2 }),
    readReceipt: async (handle: CronRunReceiptHandle) => {
      const context = getContext();
      const result = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        {
          type: "cron.currentReceipt",
          handle,
          includeJob: false,
          includeAvailability: false,
        },
        { context },
      );
      if (!result?.ok || result.type !== "cron.currentReceipt") {
        throw new Error("Cron receipt read failed");
      }
      return result.facts.receipt;
    },
    request: (requests: QueueRequest[], nowMs = now) =>
      run("cron.requestRuns", { storeKey, nowMs, requests }),
    drain: (
      requests: CronRunRequestContext[] = [],
      maxConcurrentRuns = 1,
      schedulingPaused = false,
    ) =>
      run("cron.drainQueue", {
        storeKey,
        nowMs: now + 1,
        requests,
        maxConcurrentRuns,
        schedulingPaused,
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

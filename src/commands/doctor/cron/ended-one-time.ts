import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import { resolveCronCompletionStatus } from "../../../cron/completion-status.js";
import { parseAbsoluteTimeMs } from "../../../cron/parse.js";
import {
  cronRunLogEntryToDetail,
  cronRunStorageStatus,
  isCronDeliveryStatus,
  isCronRunStatus,
} from "../../../cron/run-history-detail.js";
import type { CronRunLogEntry } from "../../../cron/run-log-types.js";
import { canRetryArchivedCronJob } from "../../../cron/service/one-shot-schedule.js";
import { resolveCronStoreKeyInDatabase } from "../../../cron/store/paths.js";
import { archiveCronRunDefinitionInDatabase } from "../../../cron/store/run-history.kernel.js";
import type { CronRunHistoryWrite } from "../../../cron/store/run-history.types.js";
import type { CronStoredJob } from "../../../cron/types.js";
import type { EngineConnection } from "../../../infra/sql-connection.js";

export function planEndedOneTimeCronRepair(jobs: readonly Record<string, unknown>[]) {
  const ended = [];
  const incompatible = [];
  const obsolete = [];
  for (const job of jobs) {
    const schedule = isRecord(job.schedule) ? job.schedule : {};
    const at = typeof schedule.at === "string" ? parseAbsoluteTimeMs(schedule.at) : null;
    const state = isRecord(job.state) ? job.state : {};
    const status = state.lastRunStatus ?? state.lastStatus;
    if (typeof job.id !== "string" || typeof job.name !== "string") {
      continue;
    }
    const busy =
      state.runningAtMs !== undefined ||
      state.runningReceiptId !== undefined ||
      state.queuedAtMs !== undefined ||
      state.runSlotWaitReceiptId !== undefined ||
      state.conditionCheckReceiptId !== undefined;
    if (busy) {
      continue;
    }
    const oneTime = schedule.kind === "at" || schedule.kind === "on-exit";
    if (
      schedule.kind === "at" &&
      job.enabled === false &&
      job.deleteAfterRun !== false &&
      at !== null &&
      typeof state.lastRunAtMs === "number" &&
      Number.isSafeInteger(state.lastRunAtMs) &&
      state.lastRunAtMs >= at &&
      isCronRunStatus(status) &&
      state.nextRunAtMs === undefined &&
      state.forcePreservedNextRunAtMs === undefined &&
      state.pacedNextRunAtMs === undefined &&
      state.startupCatchupAtMs === undefined &&
      state.admissionDeferred === undefined
    ) {
      const deliveryStatus = isCronDeliveryStatus(state.lastDeliveryStatus)
        ? state.lastDeliveryStatus
        : undefined;
      const delivered = typeof state.lastDelivered === "boolean" ? state.lastDelivered : undefined;
      const completionStatus = resolveCronCompletionStatus({ status, deliveryStatus, delivered });
      if (completionStatus !== "succeeded") {
        ended.push({
          job,
          id: job.id,
          name: job.name,
          startedAt: state.lastRunAtMs,
          status,
          deliveryStatus,
          delivered,
          completionStatus,
        });
        continue;
      }
    }
    if (
      Object.hasOwn(job, "deleteAfterRun") ||
      (schedule.kind === "on-exit" && job.enabled !== false)
    ) {
      // Explicit keep-after-run and missing on-exit policies cannot be converted without
      // changing what happens after a run. A recurring true flag also controlled session cleanup.
      if (
        (oneTime &&
          (job.deleteAfterRun === false ||
            (schedule.kind === "on-exit" && job.deleteAfterRun !== true))) ||
        (!oneTime && job.deleteAfterRun === true)
      ) {
        incompatible.push(job);
      } else {
        obsolete.push(job);
      }
    }
  }
  return { ended, incompatible, obsolete };
}

export function describeEndedOneTimeCronRepair(
  plan: ReturnType<typeof planEndedOneTimeCronRepair>,
) {
  return [
    ...plan.ended.map(({ name, id }) => `Move ended automation ${name} (${id}) to Activity.`),
    ...plan.incompatible.map(
      (job) =>
        `Keep ${job.name} (${job.id}) paused: its previous keep or cleanup policy cannot be preserved. Review it before enabling.`,
    ),
    ...(plan.obsolete.length
      ? [
          `Remove the retired one-time cleanup setting from ${plan.obsolete.length} other automations.`,
        ]
      : []),
  ];
}

export function endedOneTimeCronHistory(
  row: ReturnType<typeof planEndedOneTimeCronRepair>["ended"][number],
  storeKey: string,
): CronRunHistoryWrite {
  const { job, id, name, status, startedAt, deliveryStatus, delivered, completionStatus } = row;
  const state = isRecord(job.state) ? job.state : {};
  const durationMs =
    typeof state.lastDurationMs === "number" &&
    Number.isSafeInteger(state.lastDurationMs) &&
    state.lastDurationMs >= 0 &&
    Number.isSafeInteger(startedAt + state.lastDurationMs)
      ? state.lastDurationMs
      : 0;
  const entry: CronRunLogEntry = {
    jobId: id,
    jobName: typeof job.displayName === "string" ? job.displayName : name,
    action: "finished",
    ts: startedAt + durationMs,
    runAtMs: startedAt,
    durationMs,
    status,
    deliveryStatus,
    delivered,
    completionStatus,
    error: typeof state.lastError === "string" ? state.lastError : undefined,
    deliveryError:
      typeof state.lastDeliveryError === "string" ? state.lastDeliveryError : undefined,
    retryAvailable: canRetryArchivedCronJob(job as CronStoredJob) || undefined,
  };
  return {
    storeKey,
    jobId: id,
    runId: `doctor-ended:${id}:${startedAt}`,
    agentId: tryResolveCronJobEffectiveAgentId(job as CronStoredJob),
    startedAt,
    endedAt: entry.ts,
    status: cronRunStorageStatus(entry),
    error: entry.error,
    detail: cronRunLogEntryToDetail(entry, { storeKey, archivedJob: job }),
  };
}

export function applyEndedOneTimeCronRepair(
  jobs: Record<string, unknown>[],
  oneTimeRepair: ReturnType<typeof planEndedOneTimeCronRepair>,
) {
  const endedJobs = new Set(oneTimeRepair.ended.map((entry) => entry.job));
  for (const job of oneTimeRepair.incompatible) {
    job.enabled = false;
    const reason =
      "Paused by Doctor: the previous keep-after-run or cleanup setting is no longer supported. Review this automation before enabling it.";
    job.description =
      typeof job.description === "string" && job.description
        ? job.description + "\n\n" + reason
        : reason;
  }
  for (const job of [...oneTimeRepair.incompatible, ...oneTimeRepair.obsolete]) {
    delete job.deleteAfterRun;
  }
  return jobs.filter((job) => !endedJobs.has(job));
}

export function archiveEndedOneTimeCronRuns(
  storePath: string,
  oneTimeRepair: ReturnType<typeof planEndedOneTimeCronRepair>,
  assertSnapshotCurrent: (db: EngineConnection) => undefined,
) {
  return {
    beforeWrite(db: EngineConnection) {
      assertSnapshotCurrent(db);
      if (oneTimeRepair.ended.length > 0) {
        const storeKey = resolveCronStoreKeyInDatabase(db, storePath);
        const repairAtMs = Date.now();
        for (const row of oneTimeRepair.ended) {
          archiveCronRunDefinitionInDatabase(
            db,
            endedOneTimeCronHistory(row, storeKey),
            repairAtMs,
          );
        }
      }
      return undefined;
    },
  };
}

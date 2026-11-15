/** Identity and execution metadata for heartbeat tasks migrated into cron. */
import { createHash } from "node:crypto";
import type { DefaultProactiveJobReceipt } from "../cron/proactive-job-receipt.types.js";
import type { CronStoredJob as CronJob } from "../cron/types.js";
import type { DoctorCronJob } from "./doctor-heartbeat-jobs.js";
import { migrateHeartbeatPrompt } from "./doctor-heartbeat-legacy.js";

const HEARTBEAT_TASK_DECLARATION_PREFIX = "heartbeat-task:";
export const MIGRATED_HEARTBEAT_TASK_DESCRIPTION =
  "Migrated from heartbeat monitor scratch by openclaw doctor.";

/** Cutover receipts prove origin; the definition timestamp excludes later edits. */
export function resolveHeartbeatTaskPromptRepair(
  job: DoctorCronJob,
  receipt: DefaultProactiveJobReceipt | undefined,
  definitionUpdatedAtMs: number | undefined,
): string | undefined {
  if (
    !receipt?.convertedJobIds?.includes(job.id) ||
    job.description !== MIGRATED_HEARTBEAT_TASK_DESCRIPTION ||
    job.createdAtMs !== definitionUpdatedAtMs ||
    job.state.runningAtMs !== undefined ||
    job.payload.kind !== "agentTurn"
  ) {
    return undefined;
  }
  const message = migrateHeartbeatPrompt(job.payload.message);
  return message === job.payload.message ? undefined : message;
}

/** Whether a declaration key belongs to the doctor-owned heartbeat-task namespace. */
function isHeartbeatTaskDeclarationKey(declarationKey: string | undefined): boolean {
  return declarationKey?.startsWith(HEARTBEAT_TASK_DECLARATION_PREFIX) === true;
}

/** Stable declaration identity; duplicate names add their deterministic occurrence ordinal. */
export function heartbeatTaskDeclarationKey(
  agentId: string,
  taskName: string,
  occurrenceIndex = 0,
): string {
  const hash = createHash("sha256").update(agentId).update("\0").update(taskName);
  // Keep the first occurrence compatible with the original name-only key so a
  // doctor rerun can converge a job prepared before duplicate support landed.
  if (occurrenceIndex > 0) {
    hash.update("\0").update(String(occurrenceIndex));
  }
  const identity = hash.digest("hex").slice(0, 24);
  return `${HEARTBEAT_TASK_DECLARATION_PREFIX}${agentId}:${identity}`;
}

/** Migrated jobs keep public system-event payloads so cron tools can edit or remove them normally. */
export function isHeartbeatTaskCronJob(job: DoctorCronJob): job is CronJob & {
  declarationKey: string;
  payload: Extract<CronJob["payload"], { kind: "systemEvent" }>;
  sessionTarget: "main";
} {
  return (
    isHeartbeatTaskDeclarationKey(job.declarationKey) &&
    job.payload.kind === "systemEvent" &&
    job.sessionTarget === "main"
  );
}

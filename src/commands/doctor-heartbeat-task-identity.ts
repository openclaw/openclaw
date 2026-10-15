/** Identity and execution metadata for heartbeat tasks migrated into cron. */
import { createHash } from "node:crypto";
import type { CronStoredJob as CronJob } from "../cron/types.js";
import type { DoctorCronJob } from "./doctor-heartbeat-jobs.js";

const HEARTBEAT_TASK_DECLARATION_PREFIX = "heartbeat-task:";

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

/** Identifies the legacy rows that still need conversion to ordinary automations. */
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

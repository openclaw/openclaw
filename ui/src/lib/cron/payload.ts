import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSystemOwnedCronPayloadKind } from "../../../../src/cron/types.js";
import type { CronJob, CronPayload } from "../../api/types.ts";

function isCronPayload(value: unknown): value is CronPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "systemEvent") {
    return typeof value.text === "string";
  }
  if (value.kind === "agentTurn") {
    return typeof value.message === "string";
  }
  if (value.kind === "command") {
    return Array.isArray(value.argv) && value.argv.every((arg) => typeof arg === "string");
  }
  if (value.kind === "script") {
    return typeof value.script === "string";
  }
  if (isSystemOwnedCronPayloadKind(value.kind)) {
    return true;
  }
  return false;
}

export function getCronJobPayload(job: CronJob): CronPayload | null {
  const payload: unknown = job.payload;
  return isCronPayload(payload) ? payload : null;
}

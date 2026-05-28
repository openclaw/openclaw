import type { CronJob, CronPayload } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export function isCronPayload(value: unknown): value is CronPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "systemEvent") {
    return typeof value.text === "string";
  }
  if (value.kind === "agentTurn") {
    return typeof value.message === "string";
  }
  if (value.kind === "acpTurn") {
    return typeof value.message === "string";
  }
  return false;
}

export function isAgentPromptPayload(
  payload: CronPayload,
): payload is Extract<CronPayload, { kind: "agentTurn" } | { kind: "acpTurn" }> {
  return payload.kind === "agentTurn" || payload.kind === "acpTurn";
}

export function getCronJobPayload(job: CronJob): CronPayload | null {
  const payload = (job as { payload?: unknown }).payload;
  return isCronPayload(payload) ? payload : null;
}

export function hasCronJobPayload(job: CronJob): boolean {
  return getCronJobPayload(job) !== null;
}

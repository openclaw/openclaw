import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
} from "./dreaming.js";

/** Cron facts Doctor can read without owning the scheduler. */
export type ManagedDreamingCronJobSnapshot = {
  name?: string;
  description?: string;
  enabled?: boolean;
  payload?: {
    kind?: string;
    text?: string;
  };
  state?: {
    lastRunAtMs?: number;
    nextRunAtMs?: number;
  };
};

export type ManagedDreamingCronRunSummary = {
  managedCronPresent: boolean;
  lastRunAtMs?: number;
  nextRunAtMs?: number;
};

function finiteTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Managed dreaming jobs only. A promotion timestamp on a memory store is a different fact. */
function isManagedMemoryDreamingCronJob(job: ManagedDreamingCronJobSnapshot): boolean {
  const description = normalizeOptionalString(job.description);
  if (description?.includes(MANAGED_MEMORY_DREAMING_CRON_TAG)) {
    return true;
  }
  const name = normalizeOptionalString(job.name);
  return (
    name === MANAGED_MEMORY_DREAMING_CRON_NAME &&
    job.payload?.kind === "systemEvent" &&
    normalizeOptionalString(job.payload.text) === MEMORY_DREAMING_SYSTEM_EVENT_TEXT
  );
}

export function summarizeManagedDreamingCronJobs(
  jobs: readonly ManagedDreamingCronJobSnapshot[],
): ManagedDreamingCronRunSummary {
  const managed = jobs.filter(isManagedMemoryDreamingCronJob);
  let lastRunAtMs: number | undefined;
  let nextRunAtMs: number | undefined;
  for (const job of managed) {
    const lastRun = finiteTimestamp(job.state?.lastRunAtMs);
    if (lastRun !== undefined && (lastRunAtMs === undefined || lastRun > lastRunAtMs)) {
      lastRunAtMs = lastRun;
    }
    if (job.enabled === false) {
      continue;
    }
    const nextRun = finiteTimestamp(job.state?.nextRunAtMs);
    if (nextRun !== undefined && (nextRunAtMs === undefined || nextRun < nextRunAtMs)) {
      nextRunAtMs = nextRun;
    }
  }
  return {
    managedCronPresent: managed.length > 0,
    ...(lastRunAtMs !== undefined ? { lastRunAtMs } : {}),
    ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
  };
}

function formatRunFact(label: string, value: number | "none" | "unknown"): string {
  if (value === "unknown") {
    return `${label}: unknown.`;
  }
  if (value === "none") {
    return `${label}: none.`;
  }
  return `${label}: ${new Date(value).toISOString()}.`;
}

export function formatDoctorDreamingSummary(params: {
  cfg: OpenClawConfig;
  cron: { available: false } | { available: true; jobs: readonly ManagedDreamingCronJobSnapshot[] };
}): string {
  const resolved = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(params.cfg),
    cfg: params.cfg,
  });
  const status = resolved.enabled
    ? `Dreaming: enabled (cadence ${resolved.frequency}).`
    : "Dreaming: disabled.";
  if (!params.cron.available) {
    return [
      status,
      formatRunFact("Last dreaming run", "unknown"),
      formatRunFact("Next scheduled run", "unknown"),
    ].join("\n");
  }
  const runs = summarizeManagedDreamingCronJobs(params.cron.jobs);
  return [
    status,
    formatRunFact("Last dreaming run", runs.lastRunAtMs ?? "none"),
    formatRunFact("Next scheduled run", runs.nextRunAtMs ?? "none"),
  ].join("\n");
}

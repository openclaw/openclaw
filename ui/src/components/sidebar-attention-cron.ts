import type { CronJob } from "../api/types.ts";

// Cron lifecycle events may omit a job snapshot when the job is no longer available. Collapse
// those bursts into one authoritative inventory recovery instead of recreating a request storm.
const CRON_EVENT_FALLBACK_DEBOUNCE_MS = 50;
const CRON_SNAPSHOT_ACTION_PATTERN = /^(?:added|updated|removed|started|finished|scheduled)$/;

type CronSnapshotEvent = { removed: boolean; job: CronJob };

function readCronSnapshotEvent(payload: unknown): CronSnapshotEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  // SAFETY: Gateway event payloads are decoded objects; every consumed key is narrowed below.
  const event = payload as { action?: unknown; jobId?: unknown; job?: Partial<CronJob> };
  const job = event.job;
  return typeof event.action === "string" &&
    CRON_SNAPSHOT_ACTION_PATTERN.test(event.action) &&
    typeof job?.id === "string" &&
    job.id.length > 0 &&
    job.id === event.jobId &&
    typeof job.name === "string" &&
    typeof job.enabled === "boolean" &&
    Boolean(job.state && typeof job.state === "object" && !Array.isArray(job.state))
    ? {
        removed: event.action === "removed",
        // SAFETY: Gateway cron snapshots are full CronJob values; sidebar-required fields are revalidated above.
        job: job as CronJob,
      }
    : null;
}

function projectCronJobSnapshot(jobs: CronJob[], jobId: string, job: CronJob | null): CronJob[] {
  const index = jobs.findIndex((candidate) => candidate.id === jobId);
  if (!job) {
    return index === -1 ? jobs : jobs.toSpliced(index, 1);
  }
  return index === -1 ? [...jobs, job] : jobs.with(index, job);
}

export class SidebarAttentionCronEvents {
  private fallbackRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly overlays = new Map<string, CronJob | null>();

  beginInventoryLoad() {
    this.overlays.clear();
  }

  mergeInventory(jobs: CronJob[]): CronJob[] {
    let merged = jobs;
    for (const [jobId, job] of this.overlays) {
      merged = projectCronJobSnapshot(merged, jobId, job);
    }
    this.overlays.clear();
    return merged;
  }

  finishInventoryLoad() {
    this.overlays.clear();
  }

  projectEvent(payload: unknown, jobs: CronJob[]): CronJob[] | null {
    const event = readCronSnapshotEvent(payload);
    if (!event) {
      return null;
    }
    const job = event.removed ? null : event.job;
    this.overlays.set(event.job.id, job);
    return projectCronJobSnapshot(jobs, event.job.id, job);
  }

  queueFallbackRefresh(params: {
    isCurrent: () => boolean;
    refresh: () => void;
    waitForInventory: () => Promise<unknown>;
  }) {
    this.clearFallbackRefresh();
    const timer = globalThis.setTimeout(() => {
      void params
        .waitForInventory()
        .catch(() => undefined)
        .then(() => {
          if (this.fallbackRefreshTimer !== timer || !params.isCurrent()) {
            return;
          }
          this.fallbackRefreshTimer = null;
          params.refresh();
        });
    }, CRON_EVENT_FALLBACK_DEBOUNCE_MS);
    this.fallbackRefreshTimer = timer;
  }

  clearFallbackRefresh() {
    if (this.fallbackRefreshTimer !== null) {
      globalThis.clearTimeout(this.fallbackRefreshTimer);
      this.fallbackRefreshTimer = null;
    }
  }
}

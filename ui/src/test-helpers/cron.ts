import type { CronCompactJob, CronJob, CronJobsListResult, CronRunsResult } from "../api/types.ts";
import { DEFAULT_CRON_FORM as defaultCronForm } from "../lib/cron/state.ts";

const emptyPage = { offset: 0, limit: 50, hasMore: false, nextOffset: null };

export function createCronJob(id: string, name: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    configRevision: "config-revision-1",
    schedule: { kind: "cron", expr: "0 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
    ...overrides,
  };
}

export function cronJobsListResponse(
  jobs: CronJob[] = [],
  overrides: Partial<Omit<CronJobsListResult, "jobs">> = {},
): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "cron-jobs-fixture",
    total: jobs.length,
    ...emptyPage,
    ...overrides,
  };
}

export function createCronRunsResult(
  entries: CronRunsResult["entries"],
  overrides: Partial<Omit<CronRunsResult, "entries">> = {},
): CronRunsResult {
  return {
    entries,
    total: entries.length,
    ...emptyPage,
    ...overrides,
  };
}

export function compactCronJobFixture(job: CronJob): CronCompactJob {
  return {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    enabled: job.enabled,
    updatedAtMs: job.updatedAtMs,
    scheduleKind: job.schedule.kind,
    ...(job.schedule.kind === "at" || job.schedule.kind === "every" || job.schedule.kind === "cron"
      ? { schedule: job.schedule }
      : {}),
    nextRunAt:
      job.state.nextRunAtMs === undefined ? null : new Date(job.state.nextRunAtMs).toISOString(),
    nextRunAtMs: job.state.nextRunAtMs ?? null,
    lastRunAt:
      job.state.lastRunAtMs === undefined ? null : new Date(job.state.lastRunAtMs).toISOString(),
    lastRunAtMs: job.state.lastRunAtMs ?? null,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus ?? null,
    lastRunError: job.state.lastError ?? null,
    runningAtMs: job.state.runningAtMs,
    autoDisabled: job.state.autoDisabled,
  };
}

type CronListFixtureCase = {
  match?: Record<string, unknown>;
  response: CronJobsListResult;
};

export function cronListResponseFixture(input: CronJobsListResult | CronListFixtureCase[]) {
  const cases: CronListFixtureCase[] = Array.isArray(input) ? input : [{ response: input }];
  return {
    cases: cases.flatMap((entry) => [
      {
        match: { ...entry.match, compact: true },
        response: { ...entry.response, jobs: entry.response.jobs.map(compactCronJobFixture) },
      },
      entry,
    ]),
  };
}

export const DEFAULT_CRON_FORM = { ...defaultCronForm };

import { vi } from "vitest";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import { createInitialCronState } from "./state.ts";
import type { CronState } from "./types.ts";

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
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
    ...overrides,
  };
}

export function createStateWithRequest(
  request: unknown,
  overrides: Partial<CronState> = {},
): CronState {
  return {
    ...createInitialCronState({ connected: true, client: { request } as CronState["client"] }),
    ...overrides,
  };
}

export function createMethodRequest(
  responses: Readonly<Record<string, unknown>>,
  handlers: Readonly<Record<string, (payload?: unknown) => unknown>> = {},
) {
  return vi.fn(async (method: string, payload?: unknown) => {
    const handler = handlers[method];
    return handler ? handler(payload) : (responses[method] ?? {});
  });
}

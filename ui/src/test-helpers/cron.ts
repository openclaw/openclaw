import type { CronCompactJob, CronJob, CronJobsListResult } from "../api/types.ts";
import type { CronFormState } from "../lib/cron/types.ts";

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

export const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  sessionKey: "",
  clearAgent: false,
  enabled: true,
  deleteAfterRun: false,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  scheduleExact: false,
  staggerAmount: "",
  staggerUnit: "seconds",
  triggerEnabled: false,
  triggerScript: "",
  triggerOnce: false,
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadLocked: false,
  payloadText: "",
  payloadModel: "",
  payloadThinking: "",
  payloadLightContext: false,
  deliveryMode: "none",
  deliveryChannel: "last",
  deliveryTo: "",
  deliveryAccountId: "",
  deliveryBestEffort: false,
  deliveryThreadId: undefined,
  deliveryCompletionDestination: undefined,
  deliveryFailureDestination: undefined,
  failureAlertMode: "inherit",
  failureAlertAfter: "",
  failureAlertCooldownSeconds: "",
  failureAlertChannel: "last",
  failureAlertTo: "",
  failureAlertDeliveryMode: "",
  failureAlertAccountId: "",
  timeoutSeconds: "",
};

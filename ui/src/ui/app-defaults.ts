import type { LogLevel } from "./types.ts";
import type { CronFormState, CronRuntimeRunsFilters } from "./ui-types.ts";

export const DEFAULT_LOG_LEVEL_FILTERS: Record<LogLevel, boolean> = {
  trace: true,
  debug: true,
  info: true,
  warn: true,
  error: true,
  fatal: true,
};

export const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  enabled: true,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadText: "",
  deliveryMode: "announce",
  deliveryChannel: "last",
  deliveryTo: "",
  timeoutSeconds: "",
};

export const DEFAULT_CRON_RUNTIME_RUNS_FILTERS: CronRuntimeRunsFilters = {
  search: "",
  status: "all",
  fromLocal: "",
  toLocal: "",
  limit: "100",
  includeDisabledCron: true,
};

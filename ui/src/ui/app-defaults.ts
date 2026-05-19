import type { LogLevel } from "./types.ts";
import type { CronFormState } from "./ui-types.ts";

export const DEFAULT_LOG_LEVEL_FILTERS: Record<LogLevel, boolean> = {
  trace: true,
  debug: true,
  info: true,
  warn: true,
  error: true,
  fatal: true,
};

export const DEFAULT_SESSIONS_FILTERS = {
  activeMinutes: "120",
  limit: "200",
  includeGlobal: true,
  includeUnknown: false,
  showArchived: false,
} as const;

// Safety cap applied when `showArchived` is enabled but the user cleared the
// limit input. `showArchived=true` zeroes the activeMinutes filter on the
// gateway side, so without this fallback an empty limit field plus a sticky
// archived toggle could request every archived session on every reload.
export const SESSIONS_ARCHIVED_FALLBACK_LIMIT = 500;

export const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  sessionKey: "",
  clearAgent: false,
  enabled: true,
  deleteAfterRun: true,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  scheduleExact: false,
  staggerAmount: "",
  staggerUnit: "seconds",
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadText: "",
  payloadModel: "",
  payloadThinking: "",
  payloadLightContext: false,
  deliveryMode: "announce",
  deliveryChannel: "last",
  deliveryTo: "",
  deliveryAccountId: "",
  deliveryBestEffort: false,
  failureAlertMode: "inherit",
  failureAlertAfter: "2",
  failureAlertCooldownSeconds: "3600",
  failureAlertChannel: "last",
  failureAlertTo: "",
  failureAlertDeliveryMode: "announce",
  failureAlertAccountId: "",
  timeoutSeconds: "",
};

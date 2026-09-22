import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  CronJob,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsScheduleKindFilter,
  CronJobsTriggerFilter,
  CronJobsSortBy,
  CronRunStatus,
  CronRunScope,
  CronRunLogEntry,
  CronRunsStatusFilter,
  CronRunsStatusValue,
  CronSortDir,
  CronStatus,
  CronPayload,
} from "../../api/types.ts";

type CronDelivery = NonNullable<CronJob["delivery"]>;
type CronFormAnnounceDelivery = Extract<CronDelivery, { mode: "announce" }>;

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  sessionKey: string;
  clearAgent: boolean;
  enabled: boolean;
  deleteAfterRun: boolean;
  // Process-backed schedules are read-only because the form cannot edit their commands.
  // Preserve their schedule verbatim on save instead of rebuilding it.
  scheduleKind: "at" | "every" | "cron" | "on-exit" | "stream";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "seconds" | "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  scheduleExact: boolean;
  staggerAmount: string;
  staggerUnit: "seconds" | "minutes";
  triggerEnabled: boolean;
  triggerScript: string;
  triggerOnce: boolean;
  sessionTarget: "main" | "isolated" | "current" | `session:${string}`;
  wakeMode: "next-heartbeat" | "now";
  // System-owned payloads are always payloadLocked; the form only
  // displays it, never submits it.
  payloadKind: CronPayload["kind"];
  payloadLocked: boolean;
  payloadText: string;
  payloadModel: string;
  payloadThinking: string;
  payloadLightContext: boolean;
  deliveryMode: "none" | "announce" | "webhook";
  deliveryChannel: string;
  deliveryTo: string;
  deliveryAccountId: string;
  deliveryBestEffort: boolean;
  deliveryThreadId: CronDelivery["threadId"] | undefined;
  deliveryCompletionDestination: CronFormAnnounceDelivery["completionDestination"] | undefined;
  deliveryFailureDestination: CronDelivery["failureDestination"] | undefined;
  failureAlertMode: "inherit" | "disabled" | "custom";
  failureAlertAfter: string;
  failureAlertCooldownSeconds: string;
  failureAlertChannel: string;
  failureAlertTo: string;
  failureAlertDeliveryMode: "" | "announce" | "webhook";
  failureAlertAccountId: string;
  timeoutSeconds: string;
};

export type CronFieldKey =
  | "name"
  | "scheduleAt"
  | "everyAmount"
  | "cronExpr"
  | "staggerAmount"
  | "triggerScript"
  | "payloadText"
  | "payloadModel"
  | "payloadThinking"
  | "timeoutSeconds"
  | "deliveryTo"
  | "failureAlertAfter"
  | "failureAlertCooldownSeconds";

export type CronFieldErrors = Partial<Record<CronFieldKey, string>>;

export type CronJobsLastStatusFilter = "all" | CronRunStatus | "unknown";

export type CronState = {
  // Read admission belongs to the page; accepted mutation chains remain independent.
  canRefresh?: () => boolean;
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronLoading: boolean;
  cronJobsError: string | null;
  cronJobsLoadingMore: boolean;
  cronJobsReloadPending: boolean;
  cronJobsReloadPendingTableFilters: boolean;
  cronJobs: CronJob[];
  cronJobsSnapshotRevision: string | null;
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number | null;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: CronJobsEnabledFilter;
  cronJobsScheduleKindFilter: CronJobsScheduleKindFilter;
  cronJobsLastStatusFilter: CronJobsLastStatusFilter;
  cronJobsTriggerFilter: CronJobsTriggerFilter;
  cronJobsSortBy: CronJobsSortBy;
  cronJobsSortDir: CronSortDir;
  cronAgentId: string | null;
  cronSessionFilter?: { sessionKey: string; sessionAgentId: string };
  cronStatus: CronStatus | null;
  cronScopedTotal: number | null;
  cronScopedNextWakeAtMs: number | null;
  cronError: string | null;
  cronForm: CronFormState;
  // True while the create panel owns the detail pane; job selection (editing)
  // always wins over it when deriving the visible panel.
  cronCreateOpen: boolean;
  cronFieldErrors: CronFieldErrors;
  // Exact definition the editor was opened or refreshed against; cronJobs is
  // only the current filtered/paged table cache.
  cronEditingJob: CronJob | null;
  cronCloningJob: CronJob | null;
  cronRunsError: string | null;
  cronRunsJobId: string | null;
  cronRunsLoadingMore: boolean;
  cronRuns: CronRunLogEntry[];
  cronRunsTotal: number;
  cronRunsHasMore: boolean;
  cronRunsNextOffset: number | null;
  cronRunsLimit: number;
  cronRunsScope: CronRunScope;
  cronRunsStatuses: CronRunsStatusValue[];
  cronRunsDeliveryStatuses: CronDeliveryStatus[];
  cronRunsStatusFilter: CronRunsStatusFilter;
  cronRunsQuery: string;
  cronRunsSortDir: CronSortDir;
  cronBusy: boolean;
};

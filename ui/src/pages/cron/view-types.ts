import type {
  ChannelUiMetaEntry,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsScheduleKindFilter,
  CronJobsTriggerFilter,
  CronRunsStatusValue,
  CronJobsSortBy,
  CronSortDir,
} from "../../api/types.ts";
import type { CronRunsViewState } from "../../lib/cron/runs.ts";
import type {
  CronFieldErrors,
  CronFormState,
  CronJobsLastStatusFilter,
  CronPendingAction,
} from "../../lib/cron/types.ts";

export type CronListTab = "tasks" | "activity";
export type CronDetailTab = "settings" | "history";
export type CronProps = {
  basePath: string;
  agentId: string;
  loading: boolean;
  /** True once a cron.list response has completed (initial load finished). */
  hasLoaded: boolean;
  listError: string | null;
  /** Canonical gateway capability for every mutation-capable cron control. */
  canManage: boolean;
  jobsLoadingMore: boolean;
  status: CronStatus | null;
  jobs: CronJob[];
  jobsTotal: number;
  jobsHasMore: boolean;
  jobsQuery: string;
  jobsEnabledFilter: CronJobsEnabledFilter;
  jobsScheduleKindFilter: CronJobsScheduleKindFilter;
  jobsLastStatusFilter: CronJobsLastStatusFilter;
  jobsTriggerFilter: CronJobsTriggerFilter;
  jobsSortBy: CronJobsSortBy;
  jobsSortDir: CronSortDir;
  error: string | null;
  /** Mutation lock shared by save, run, toggle, and remove. */
  busy: boolean;
  /** Which mutation holds the lock, so a control only announces its own work. */
  pendingAction: CronPendingAction | null;
  form: CronFormState;
  heartbeatScratch: string;
  fieldErrors: CronFieldErrors;
  canSubmit: boolean;
  editingJob: CronJob | null;
  createOpen: boolean;
  listTab: CronListTab;
  detailTab: CronDetailTab;
  channels: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  runs: CronRunLogEntry[];
  runsState: CronRunsViewState;
  highlightedRunId?: string | null;
  runsTotal: number;
  runsHasMore: boolean;
  runsLoadingMore: boolean;
  runsStatuses: CronRunsStatusValue[];
  runsDeliveryStatuses: CronDeliveryStatus[];
  runsQuery: string;
  runsSortDir: CronSortDir;
  agentSuggestions: string[];
  modelSuggestions: string[];
  thinkingSuggestions: string[];
  timezoneSuggestions: string[];
  deliveryToSuggestions: string[];
  failureAlertToSuggestions: string[];
  accountSuggestions: string[];
  onListTabChange: (tab: CronListTab) => void;
  onDetailTabChange: (tab: CronDetailTab) => void;
  onFormChange: (patch: Partial<CronFormState>) => void;
  onRefresh: () => void;
  onSubmit: () => void;
  onSubmitRunNow: () => void;
  onSelectJob: (job: CronJob) => void;
  onOpenCreate: (patch?: Partial<CronFormState>) => void;
  onClosePanel: () => void;
  onClone: (job: CronJob) => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob, mode?: "force" | "due") => void;
  onRemove: (job: CronJob) => void;
  onLoadMoreJobs: () => void;
  onJobsFiltersChange: (patch: {
    cronJobsQuery?: string;
    cronJobsEnabledFilter?: CronJobsEnabledFilter;
    cronJobsScheduleKindFilter?: CronJobsScheduleKindFilter;
    cronJobsLastStatusFilter?: CronJobsLastStatusFilter;
    cronJobsTriggerFilter?: CronJobsTriggerFilter;
    cronJobsSortBy?: CronJobsSortBy;
    cronJobsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onJobsFiltersReset: () => void | Promise<void>;
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onViewRunTranscript?: (entry: CronRunLogEntry) => void;
};

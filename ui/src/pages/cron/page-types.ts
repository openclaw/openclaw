import type {
  CronDeliveryStatus,
  CronJob,
  CronRunLogEntry,
  CronRunsStatusValue,
  CronSortDir,
} from "../../api/types.ts";
import type { updateCronJobsFilter } from "../../lib/cron/index.ts";
import type { CronFormState } from "../../lib/cron/types.ts";

export type CronListTab = "tasks" | "activity";
export type CronDetailTab = "settings" | "history";
export type CronActions = {
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
  onRemove: (job: CronJob) => void | Promise<void>;
  onLoadMoreJobs: () => void;
  onJobsFiltersChange: (patch: Parameters<typeof updateCronJobsFilter>[1]) => void | Promise<void>;
  onJobsFiltersReset: () => void | Promise<void>;
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsRunId?: string | null;
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  /** The owner reads current entries after publication; cleanup retires the mounted row. */
  onRunMount?: (element: HTMLElement, entry: () => CronRunLogEntry) => (() => void) | undefined;
  onViewRunTranscript?: (entry: CronRunLogEntry, trigger: HTMLButtonElement) => void;
};

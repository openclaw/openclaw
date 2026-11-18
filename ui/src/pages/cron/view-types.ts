import type { CronJob } from "../../api/types.ts";
import type { buildCronViewProps } from "./view-props.ts";

type CronViewProps = ReturnType<typeof buildCronViewProps>;
type OptionalViewProp =
  | "ownerOptions"
  | "reads"
  | "eventSource"
  | "channelLabels"
  | "channelMeta"
  | "highlightedRunId"
  | "onRunMount"
  | "onRetryRun";

export type CronProps = Omit<CronViewProps, OptionalViewProp | "gateway"> &
  Partial<Pick<CronViewProps, OptionalViewProp>> & {
    gateway: CronViewProps["gateway"] | null;
    canCreate?: boolean;
    /** No sidebar lists the automations (the native embed), so the page lists them itself. */
    listsJobs?: boolean;
    canManageJob?: (job: CronJob) => boolean;
    toggleSavingJobId?: string | null;
  };

export type CronPanelMode = "overview" | "create" | "job";

export type CronJobActionProps = Pick<
  CronProps,
  | "canManage"
  | "canCreate"
  | "busy"
  | "connected"
  | "toggleSavingJobId"
  | "onRun"
  | "onToggle"
  | "onClone"
  | "onRemove"
>;

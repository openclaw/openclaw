import type { buildCronViewProps } from "./view-props.ts";

type CronViewProps = ReturnType<typeof buildCronViewProps>;
type OptionalViewProp =
  | "ownerOptions"
  | "canCreate"
  | "canManageJob"
  | "reads"
  | "eventSource"
  | "channelLabels"
  | "channelMeta"
  | "highlightedRunId"
  | "onViewRunTranscript"
  | "onRunMount";

export type CronProps = Omit<CronViewProps, OptionalViewProp | "gateway"> &
  Partial<Pick<CronViewProps, OptionalViewProp>> & {
    gateway: CronViewProps["gateway"] | null;
    toggleSavingJobId?: string | null;
    focus?: {
      readonly target: string | undefined;
      remember: (id: string, order: string[]) => void;
      ref: (id: string) => (element: HTMLElement) => void;
    };
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

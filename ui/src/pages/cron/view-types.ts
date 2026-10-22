import type { buildCronViewProps } from "./view-props.ts";

type CronViewProps = ReturnType<typeof buildCronViewProps>;
type OptionalViewProp =
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
  };

export type CronPanelMode = "overview" | "create" | "job";

export type CronJobActionProps = Pick<
  CronProps,
  "canManage" | "busy" | "connected" | "onRun" | "onToggle" | "onClone" | "onRemove"
>;

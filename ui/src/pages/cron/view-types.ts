import type { ChannelUiMetaEntry } from "../../api/types.ts";
import type { CronEventSourceView } from "./event-source.ts";
import type { CronActions } from "./page-types.ts";
import type { buildCronViewProps } from "./view-props.ts";

export type CronProps = Omit<
  ReturnType<typeof buildCronViewProps>,
  keyof CronActions | "eventSource" | "channelLabels" | "channelMeta" | "highlightedRunId"
> &
  CronActions & {
    eventSource?: CronEventSourceView;
    channelLabels?: Record<string, string>;
    channelMeta?: ChannelUiMetaEntry[];
    highlightedRunId?: string | null;
  };

export type CronPanelMode = "overview" | "create" | "job";

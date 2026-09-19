import {
  projectAgentActivityItem,
  isCompleteAgentPreamble,
} from "../agents/agent-activity-presentation.js";
import {
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftLine,
  type ChannelProgressDraftLineInput,
  type ChannelProgressLineOptions,
  type StreamingCompatEntry,
} from "./streaming.js";

type ProgressPayload<TEvent extends ChannelProgressDraftLineInput["event"]> = Omit<
  Extract<ChannelProgressDraftLineInput, { event: TEvent }>,
  "event"
>;

type ToolProgressPayload = ProgressPayload<"tool"> & { detailMode?: "explain" | "raw" };
type ItemProgressPayload = Omit<ProgressPayload<"item">, "itemKind"> & { kind?: string };
type ChannelProgressDraftEventLine = string | ChannelProgressDraftLine;
export type ChannelProgressDraftEventLineBuilder = (
  input: ChannelProgressDraftLineInput,
  options?: ChannelProgressLineOptions,
) => ChannelProgressDraftEventLine | undefined;

export function createChannelProgressDraftEventHandlers(params: {
  entry: StreamingCompatEntry | null | undefined;
  preparedItems?: boolean;
  buildLine?: ChannelProgressDraftEventLineBuilder;
  onTool?: (payload: ToolProgressPayload) => void;
  onItem?: (payload: ItemProgressPayload) => void;
  pushLine: (
    line: ChannelProgressDraftEventLine | undefined,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => Promise<boolean>;
}) {
  const pushEvent = (
    input: Exclude<ChannelProgressDraftLineInput, { event: "plan" }>,
    detailMode?: "explain" | "raw",
  ) => {
    const options = detailMode ? { detailMode } : undefined;
    const line = params.buildLine
      ? params.buildLine(input, options)
      : buildChannelProgressDraftLineForEntry(params.entry, input, options);
    return params.pushLine(line, input.event === "tool" ? { toolName: input.name?.trim() } : {});
  };

  return {
    pushToolEvent: (payload: ToolProgressPayload) => {
      params.onTool?.(payload);
      const { detailMode, ...input } = payload;
      const activity = projectAgentActivityItem(
        { name: payload.name, status: "running" },
        { args: payload.args },
      );
      return params.preparedItems || activity.hideFromChannelProgress
        ? Promise.resolve(false)
        : pushEvent({ event: "tool", ...input }, detailMode);
    },
    pushItemEvent: (payload: ItemProgressPayload) => {
      const { kind: itemKind, ...input } = payload;
      params.onItem?.(payload);
      if (payload.hideFromChannelProgress || payload.suppressChannelProgress) {
        return Promise.resolve(false);
      }
      return pushEvent({ event: "item", ...input, itemKind });
    },
    pushApprovalEvent: (payload: ProgressPayload<"approval">) => {
      return payload.phase === "requested"
        ? pushEvent({ event: "approval", ...payload })
        : Promise.resolve(false);
    },
    pushCommandOutputEvent: (payload: ProgressPayload<"command-output">) =>
      !params.preparedItems && payload.phase === "end"
        ? pushEvent({ event: "command-output", ...payload })
        : Promise.resolve(false),
    pushPatchEvent: (payload: ProgressPayload<"patch">) =>
      !params.preparedItems && payload.phase === "end"
        ? pushEvent({ event: "patch", ...payload })
        : Promise.resolve(false),
  };
}

export function routePreparedProgressItem(params: {
  payload: ItemProgressPayload;
  progressMode: boolean;
  commentary: boolean;
  handlers: Pick<ReturnType<typeof createChannelProgressDraftEventHandlers>, "pushItemEvent">;
  clearLine: (id: string) => Promise<boolean>;
  pushCommentary: (
    text: string | undefined,
    options: { itemId?: string; complete: boolean },
  ) => Promise<boolean>;
  pushHeadline: (text: string | undefined, options: { itemId?: string }) => Promise<boolean>;
}): Promise<boolean> {
  const { payload, handlers } = params;
  if (payload.kind !== "preamble") {
    const id = payload.itemId;
    if (payload.hideFromChannelProgress && id) {
      return handlers.pushItemEvent(payload).then(() => params.clearLine(id));
    }
    return handlers.pushItemEvent(payload);
  }
  if (!isCompleteAgentPreamble(payload)) {
    return Promise.resolve(false);
  }
  if (!params.progressMode) {
    return handlers.pushItemEvent(payload);
  }
  return params.commentary
    ? params.pushCommentary(payload.progressText, { itemId: payload.itemId, complete: true })
    : params.pushHeadline(payload.progressText, { itemId: payload.itemId });
}

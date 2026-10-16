import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, Show } from "solid-js";
import type { ThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ChatReplyTarget, MessageGroup, ChatItem } from "../../../lib/chat/chat-types.ts";
import { describeToolGroup, readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { formatDurationLong } from "../../../lib/format-duration.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../components/tooltip.ts";
import { ChatAvatar, type ChatAvatarProps } from "../chat-avatar-view.tsx";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./chat-message-markdown-view.tsx";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";
import { ChatQuestionSummary } from "./chat-question-summary.tsx";
import { resolveGroupReplyLine } from "./chat-reply-attribution.ts";
import { ReplyLineView, ReplyLineConnector } from "./chat-reply-attribution.tsx";
import type { ReplyPreviewLookup } from "./chat-reply-preview.types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import type { SubagentActivityProps } from "./chat-subagent-activity.ts";
import { BrowserTabPreviews, syncToolDisclosureOverflow } from "./chat-tool-cards.solid.tsx";
import type { BrowserTabPreview } from "./chat-tool-cards.ts";
import { ChatToolOutcomeSummary } from "./chat-tool-outcome-summary.solid.tsx";
import { summarizeToolCardOutcomes } from "./chat-tool-render-model.ts";
import { ChatWorkingIndicator } from "./chat-working-indicator.tsx";

/** A contiguous run of in-flight streaming items rendered under one assistant group. */
export type StreamGroupPart = Extract<
  ChatItem,
  { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" }
>;

type StreamMessageOptions = Pick<
  GroupedMessageOptions,
  | "onOpenReply"
  | "replyNavigationId"
  | "sessionKey"
  | "presented"
  | "boardProvider"
  | "widgetLayout"
  | "agentId"
  | "runActive"
  | "asyncQuestions"
  | "onRequestUpdate"
  | "canvasPluginSurfaceUrl"
  | "resourceBasePath"
  | "mediaPolicyKey"
  | "connectionEpoch"
  | "assistantAttachmentAuthToken"
  | "resolveArtifactDownload"
  | "getTurnVideoMessages"
  | "onRequestOpenImage"
  | "onOpenImage"
  | "onAssistantAttachmentLoaded"
  | "embedSandboxMode"
  | "allowExternalEmbedUrls"
  | "fetchLinkFavicon"
  | "pluginToolIcons"
  | "githubRepo"
  | "githubRepositories"
  | "onOpenWorkspaceFile"
  | "onPermissionRetry"
>;

export type StreamGroupOptions = StreamMessageOptions & {
  resolveReplyPreview?: ReplyPreviewLookup;
  branding?: ThemeBranding;
  bubbleMode?: boolean;
  firstBubbleKey?: string | null;
  entryRefFor?: (key: string) => ((element?: Element) => void) | undefined;
  onReply?: (target: ChatReplyTarget) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  assistant?: ChatAvatarProps["assistant"];
  showAssistantAvatar?: boolean;
  startupLabel?: string;
  retryAt?: number;
  waitingApproval?: boolean;
  waitingSubagents?: ChatSubagentWait;
  runningSubagents?: number;
  subagentActivity?: SubagentActivityProps;
  onOpenSubagents?: () => void;
  runOutputTokens?: number | null;
  questionPrompts?: ReadonlyMap<string, QuestionPrompt>;
};

export function StreamGroupParts(props: {
  parts: StreamGroupPart[];
  options: StreamGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  return (
    <For each={props.parts} keyed={(part) => `${part.kind}:${part.key}`}>
      {(part) => (
        <StreamPartView
          part={part()}
          options={{
            ...props.options,
            firstBubbleKey:
              props.options.firstBubbleKey !== undefined
                ? props.options.firstBubbleKey
                : (props.parts.find(
                    (candidate) => candidate.kind === "stream" && candidate.text.trim(),
                  )?.key ?? null),
          }}
          presentation={props.presentation}
        />
      )}
    </For>
  );
}

export function UnplacedSubagentWait(props: {
  sessionKey: string;
  wait: ChatSubagentWait;
  options: StreamGroupOptions;
}) {
  const parts = createMemo<StreamGroupPart[]>(() => [
    {
      kind: "reading-indicator",
      key: `waiting-subagents:${props.sessionKey}`,
      startedAt: props.wait.startedAt,
      waitingOn: "subagents",
    },
  ]);
  return <StreamGroup parts={parts()} options={props.options} />;
}

export function StreamPartView(props: {
  part: StreamGroupPart;
  options: StreamGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  const stream = () => (props.part.kind === "stream" ? props.part : undefined);
  return (
    <Show when={stream()} fallback={<NonstreamPart {...props} />}>
      <StreamingMessage part={stream} options={props.options} />
    </Show>
  );
}

function NonstreamPart(props: {
  part: StreamGroupPart;
  options: StreamGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  const indicator = () => (props.part.kind === "reading-indicator" ? props.part : undefined);
  const question = createMemo(() => {
    const prompt =
      props.part.kind === "question"
        ? props.options.questionPrompts?.get(props.part.questionId)
        : undefined;
    return prompt;
  });
  return (
    <Show
      when={indicator()}
      fallback={
        <Show when={question()}>{(prompt) => <ChatQuestionSummary prompt={prompt()} />}</Show>
      }
    >
      {(part) => (
        <ChatWorkingIndicator
          part={part()}
          options={{
            bubbleMode: props.options.bubbleMode,
            mascot: props.options.branding?.mascot,
            workingIndicator: props.options.branding?.workingIndicator,
            workingPhrases: props.options.branding?.workingPhrases,
            waitingApproval: props.options.waitingApproval === true,
            waitingSubagents:
              part().waitingOn === "subagents" ? props.options.waitingSubagents : undefined,
            runningSubagents: props.options.runningSubagents,
            subagentActivity: props.options.subagentActivity,
            onOpenSubagents: props.options.onOpenSubagents,
            startupLabel: props.options.startupLabel,
            retryAt: props.options.retryAt,
            outputTokens: props.options.runOutputTokens,
            presentation: props.presentation,
          }}
        />
      )}
    </Show>
  );
}

function StreamingMessage(props: {
  part: () => Extract<StreamGroupPart, { kind: "stream" }> | undefined;
  options: StreamGroupOptions;
}) {
  const part = () => props.part()!;
  const prepared = createMemo(() =>
    prepareChatMessageRender({
      role: "assistant",
      content: [
        ...(part().thinking ? [{ type: "thinking", thinking: part().thinking }] : []),
        { type: "text", text: part().text },
      ],
      timestamp: part().startedAt,
    }),
  );
  const actions = createMemo(() =>
    resolveMessageActionDetails(prepared(), {
      messageId: part().key,
      onReply: props.options.onReply,
      senderLabel: props.options.assistant?.name ?? "Assistant",
    }),
  );
  return (
    <GroupedMessage
      preparation={prepared()}
      messageKey={part().key}
      options={{
        ...props.options,
        isStreaming: part().isStreaming,
        entryRef: props.options.entryRefFor?.(part().key),
        showReasoning: Boolean(part().thinking),
        messageActions: actions(),
      }}
      onOpenSidebar={props.options.onOpenSidebar}
    />
  );
}

// One assistant group per contiguous run of streaming items: a reply that
// arrives as several stream segments renders under a single avatar/footer
// instead of flashing a separate avatar+bubble per segment (#63956).
export function StreamGroup(props: { parts: StreamGroupPart[]; options: StreamGroupOptions }) {
  const starts = () =>
    props.parts.flatMap((part) => (part.kind === "stream" ? [part.startedAt] : []));
  const startedAt = () => (starts().length ? Math.min(...starts()) : null);
  const active = () =>
    props.parts.some(
      (part) => part.kind === "reading-indicator" || (part.kind === "stream" && part.isStreaming),
    );
  const source = () => props.parts.find((part) => part.kind === "stream");
  const hasAvatar = () => Boolean(source() && props.options.showAssistantAvatar !== false);
  const replyLine = () =>
    resolveGroupReplyLine(
      {
        role: "assistant",
        messages: [],
        replyToSender: source()?.replyToSender,
        replyToMessage: source()?.replyToMessage,
      },
      props.options.resolveReplyPreview,
    );
  const hasReply = () => replyLine().state !== "hidden" && hasAvatar();
  return (
    <div
      class={[
        "chat-group assistant",
        {
          "chat-group--reply": hasReply(),
          "chat-group--working": !source(),
          "chat-group--with-footer": startedAt() !== null,
        },
      ]}
      data-chat-row-key={props.parts[0]?.key}
    >
      <Show when={hasAvatar()}>
        <ChatAvatar role="assistant" assistant={props.options.assistant} />
      </Show>
      <div class="chat-group-messages">
        <ReplyLineView line={replyLine()} actions={props.options} />
        <StreamGroupParts parts={props.parts} options={props.options} presentation="standalone" />
      </div>
      <Show when={hasAvatar()}>
        <ReplyLineConnector line={replyLine()} avatar={true} />
      </Show>
      <Show when={startedAt() !== null}>
        <div class="chat-group-footer" aria-hidden={active() ? "true" : undefined}>
          <Show when={!active()}>
            <div class="chat-group-footer__meta">
              <span class="chat-sender-name">{props.options.assistant?.name ?? "Assistant"}</span>
              <ChatTimestamp timestamp={startedAt()!} />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** A streaming answer already ends its turn: reserve its footer row before the footer content exists. */
export function renderSolidEmptyGroupFooter() {
  return <div class="chat-group-footer" aria-hidden="true" />;
}

type WorkGroupSummaryItem = {
  key: string;
  durationMs: number | null;
  groups: readonly MessageGroup[];
};
type WorkGroupSummaryOptions = {
  expanded: boolean;
  onToggle: () => void;
  presentation?: "standalone" | "continuation";
  browserTabPreviews?: readonly BrowserTabPreview[];
  bubbleMode?: boolean;
};

function prepareWorkGroupSummary(item: WorkGroupSummaryItem) {
  const duration = formatDurationLong(item.durationMs);
  const entries = item.groups.flatMap((group) =>
    group.messages.map(({ message }) => ({
      cards: extractToolCardsCached(message),
      // An explicit empty projection also owns the message: its calls were hidden.
      activity: Array.isArray(asOptionalRecord(message)?.activity)
        ? readPreparedActivity(message)
        : undefined,
    })),
  );
  const prepared = entries.flatMap(({ cards, activity }) =>
    activity === undefined ? [] : [{ cards, activity }],
  );
  const preparedCallIds = new Set(
    prepared.flatMap(({ cards, activity }) => [
      ...cards.flatMap((card) => (card.callId ? [card.callId] : [])),
      ...activity.map((activityItem) => activityItem.toolCallId ?? activityItem.itemId),
    ]),
  );
  const cardsById = new Map(
    entries.flatMap((entry) => entry.cards).map((card) => [card.callId ?? card, card]),
  );
  const cards = [...cardsById.values()];
  const rawCards = new Set(
    entries.filter((entry) => entry.activity === undefined).flatMap((entry) => entry.cards),
  );
  const fallback = cards.filter(
    (card) => rawCards.has(card) && (!card.callId || !preparedCallIds.has(card.callId)),
  );
  const activity = prepared.flatMap((entry) => entry.activity);
  for (const [index, card] of fallback.entries()) {
    const outcome = resolveToolCardOutcome(card, false);
    const display = resolveToolDisplay(card);
    activity.push({
      itemId: `work-summary-raw:${index}`,
      toolCallId: card.callId,
      kind: "tool",
      phase: "end",
      title: display.name,
      name: display.name,
      status: outcome === "succeeded" ? "completed" : outcome === "unknown" ? undefined : outcome,
    });
  }
  const label = duration ? t("chat.workRun.workedFor", { duration }) : t("chat.workRun.worked");
  const summary = describeToolGroup(activity);
  const total = summary.total;
  const outcomes = summary.outcomes.filter(({ kind }) => kind !== "failed" && kind !== "skipped");
  const toolOutcomes = summarizeToolCardOutcomes(cards, activity);
  return { label, total, outcomes, cards, activity, toolOutcomes };
}

function WorkGroupSummaryBody(props: {
  summary: ReturnType<typeof prepareWorkGroupSummary>;
  options: WorkGroupSummaryOptions;
}) {
  const compact = () => props.options.bubbleMode;
  return (
    <div
      class={[
        "chat-activity-group chat-work-group",
        {
          "is-open": props.options.expanded,
          "chat-activity-group--bubble": compact(),
        },
      ]}
    >
      <button
        class="chat-inline-disclosure chat-activity-group__summary"
        type="button"
        aria-expanded={props.options.expanded ? "true" : "false"}
        onPointerEnter={syncToolDisclosureOverflow}
        onFocus={syncToolDisclosureOverflow}
        onClick={() => props.options.onToggle()}
      >
        <span class="chat-tool-disclosure__content">
          <span class="chat-activity-group__label">{props.summary.label}</span>
        </span>
        <Show when={props.options.expanded && props.summary.total > 0}>
          <span class="chat-work-group__total">
            {" · "}
            {t(`chat.workRun.toolCalls${props.summary.total === 1 ? "One" : "Many"}`, {
              count: String(props.summary.total),
            })}
          </span>
        </Show>
        <For each={props.summary.outcomes} keyed={(outcome) => outcome.kind}>
          {(outcome) => (
            <span class="chat-activity-group__outcome muted">
              {" · "}
              {outcome().label}
            </span>
          )}
        </For>
        <Show
          when={props.summary.toolOutcomes.failed > 0 || props.summary.toolOutcomes.skipped > 0}
        >
          <span class="chat-work-group__outcomes">
            {" · "}
            <ChatToolOutcomeSummary
              cards={props.summary.cards}
              activity={props.summary.activity}
              style={{ display: "contents" }}
            />
          </span>
        </Show>
        <span class="chat-tool-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </button>
      <div class="chat-work-group__separator" aria-hidden="true" />
      <Show when={!props.options.expanded && !props.options.bubbleMode}>
        <BrowserTabPreviews previews={props.options.browserTabPreviews} />
      </Show>
    </div>
  );
}

/** Completed work keeps elapsed time and outcomes above the expandable narration. */
export function WorkGroupSummary(props: {
  item: WorkGroupSummaryItem;
  options: WorkGroupSummaryOptions;
}) {
  const summary = createMemo(() => prepareWorkGroupSummary(props.item));
  return (
    <Show
      when={props.options.presentation === "continuation"}
      fallback={
        <div
          class="chat-group tool chat-group--turn-block chat-group--work"
          data-chat-row-key={props.item.key}
        >
          <div class="chat-group-messages">
            <WorkGroupSummaryBody summary={summary()} options={props.options} />
          </div>
        </div>
      }
    >
      <WorkGroupSummaryBody summary={summary()} options={props.options} />
    </Show>
  );
}

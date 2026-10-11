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
import {
  emptyLegacyContent as litNothing,
  LitContent,
  type LegacyTemplateResult,
} from "../../../lit/solid-content.tsx";
import { renderChatAvatar } from "../chat-avatar.ts";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./chat-message-markdown-view.tsx";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";
import { renderChatQuestionSummary } from "./chat-question-card.ts";
import {
  renderReplyLine,
  renderReplyLineConnector,
  resolveGroupReplyLine,
} from "./chat-reply-attribution.ts";
import type { ReplyPreviewLookup } from "./chat-reply-preview.types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { syncToolDisclosureOverflow } from "./chat-tool-cards.ts";
import { renderToolOutcomeSummary } from "./chat-tool-outcome-summary.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

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
>;

export type StreamGroupOptions = StreamMessageOptions & {
  resolveReplyPreview?: ReplyPreviewLookup;
  branding?: ThemeBranding;
  bubbleMode?: boolean;
  firstBubbleKey?: string | null;
  entryRefFor?: (key: string) => ((element?: Element) => void) | undefined;
  onReply?: (target: ChatReplyTarget) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  assistant?: Parameters<typeof renderChatAvatar>[1];
  showAssistantAvatar?: boolean;
  startupLabel?: string;
  waitingApproval?: boolean;
  waitingSubagents?: ChatSubagentWait;
  runningSubagents?: number;
  subagentActivity?: LegacyTemplateResult;
  onOpenSubagents?: () => void;
  runOutputTokens?: number | null;
  questionPrompts?: ReadonlyMap<string, QuestionPrompt>;
};

export function renderSolidStreamGroupParts(
  parts: StreamGroupPart[],
  opts: StreamGroupOptions,
  presentation: "standalone" | "continuation",
) {
  return <StreamGroupParts parts={parts} options={opts} presentation={presentation} />;
}

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

/** A wait no loaded handoff can place: the standard working row, after the transcript. */
export function renderSolidUnplacedSubagentWait(
  sessionKey: string,
  wait: ChatSubagentWait,
  opts: StreamGroupOptions,
) {
  return <UnplacedSubagentWait sessionKey={sessionKey} wait={wait} options={opts} />;
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
      startedAt: props.wait.startedAt ?? 0,
      waitingOn: "subagents",
    },
  ]);
  return <StreamGroup parts={parts()} options={props.options} />;
}

export function renderSolidStreamGroupPart(
  part: StreamGroupPart,
  opts: StreamGroupOptions,
  presentation: "standalone" | "continuation",
) {
  return <StreamPartView part={part} options={opts} presentation={presentation} />;
}

export function StreamPartView(props: {
  part: StreamGroupPart;
  options: StreamGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  const stream = () => (props.part.kind === "stream" ? props.part : undefined);
  return (
    <Show
      when={stream()}
      fallback={
        <NonstreamPart
          part={props.part}
          options={props.options}
          presentation={props.presentation}
        />
      }
    >
      <StreamingMessage part={stream} options={props.options} />
    </Show>
  );
}

function NonstreamPart(props: {
  part: StreamGroupPart;
  options: StreamGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  const content = createMemo(() => {
    if (props.part.kind === "reading-indicator") {
      return renderChatWorkingIndicator(props.part, {
        bubbleMode: props.options.bubbleMode,
        mascot: props.options.branding?.mascot,
        workingIndicator: props.options.branding?.workingIndicator,
        workingPhrases: props.options.branding?.workingPhrases,
        waitingApproval: props.options.waitingApproval === true,
        waitingSubagents:
          props.part.waitingOn === "subagents" ? props.options.waitingSubagents : undefined,
        runningSubagents: props.options.runningSubagents,
        subagentActivity: props.options.subagentActivity,
        onOpenSubagents: props.options.onOpenSubagents,
        startupLabel: props.options.startupLabel,
        outputTokens: props.options.runOutputTokens,
        presentation: props.presentation,
      });
    }
    const prompt =
      props.part.kind === "question"
        ? props.options.questionPrompts?.get(props.part.questionId)
        : undefined;
    return prompt ? renderChatQuestionSummary(prompt) : litNothing;
  });
  return <LitContent value={content()} />;
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
export function renderSolidStreamGroup(parts: StreamGroupPart[], opts: StreamGroupOptions = {}) {
  return <StreamGroup parts={parts} options={opts} />;
}

export function StreamGroup(props: { parts: StreamGroupPart[]; options: StreamGroupOptions }) {
  const starts = () =>
    props.parts.flatMap((part) => (part.kind === "stream" ? [part.startedAt] : []));
  const startedAt = () => (starts().length ? Math.min(...starts()) : null);
  const active = () =>
    props.parts.some(
      (part) => part.kind === "reading-indicator" || (part.kind === "stream" && part.isStreaming),
    );
  const source = () => props.parts.find((part) => part.kind === "stream");
  const avatar = () =>
    source() && props.options.showAssistantAvatar !== false
      ? renderChatAvatar("assistant", props.options.assistant)
      : litNothing;
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
  const hasReply = () => replyLine().state !== "hidden" && avatar() !== litNothing;
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
      <LitContent value={avatar()} />
      <div class="chat-group-messages">
        <LitContent value={renderReplyLine(replyLine(), props.options)} />
        <StreamGroupParts parts={props.parts} options={props.options} presentation="standalone" />
      </div>
      <LitContent value={renderReplyLineConnector(replyLine(), avatar())} />
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
  browserTabPreviews?: unknown;
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
  return { label, total, outcomes, toolOutcomes: renderToolOutcomeSummary(cards, true, activity) };
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
        <Show when={props.summary.toolOutcomes !== litNothing}>
          <span class="chat-work-group__outcomes">
            {" · "}
            <LitContent value={props.summary.toolOutcomes} />
          </span>
        </Show>
        <span class="chat-tool-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </button>
      <div class="chat-work-group__separator" aria-hidden="true" />
      <Show when={!props.options.expanded && !props.options.bubbleMode}>
        <LitContent value={props.options.browserTabPreviews} />
      </Show>
    </div>
  );
}

/** Completed work keeps elapsed time and outcomes above the expandable narration. */
export function renderSolidWorkGroupSummary(
  item: WorkGroupSummaryItem,
  options: WorkGroupSummaryOptions,
) {
  return <WorkGroupSummary item={item} options={options} />;
}

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

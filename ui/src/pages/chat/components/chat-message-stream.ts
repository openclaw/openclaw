import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem, MessageGroup } from "../../../lib/chat/chat-types.ts";
import { describeToolGroup, readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import {
  extractToolCardsCached,
  isToolCardSkipped,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { renderChatAvatar } from "../chat-avatar.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
  type MessageReplyTarget,
} from "./chat-message-markdown.ts";
import { renderChatTimestamp } from "./chat-message-timestamp.ts";
import { renderChatQuestionSummary } from "./chat-question-card.ts";
import { renderChatReplyAttribution } from "./chat-reply-attribution.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { shouldToggleSelectableDisclosure, syncToolDisclosureOverflow } from "./chat-tool-cards.ts";
import { renderToolOutcomeSummary } from "./chat-tool-outcome-summary.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

/** A contiguous run of in-flight streaming items rendered under one assistant group. */
export type StreamGroupPart = Extract<
  ChatItem,
  { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" }
>;

type StreamMessageOptions = Pick<
  Parameters<typeof renderGroupedMessage>[2],
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
  branding?: ThemeBranding;
  entryRefFor?: (key: string) => ((element?: Element) => void) | undefined;
  onReply?: (target: MessageReplyTarget) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  assistant?: Parameters<typeof renderChatAvatar>[1];
  showAssistantAvatar?: boolean;
  startupLabel?: string;
  waitingApproval?: boolean;
  runOutputTokens?: number | null;
  questionPrompts?: ReadonlyMap<string, QuestionPrompt>;
};

export function renderStreamGroupParts(
  parts: StreamGroupPart[],
  opts: StreamGroupOptions,
  presentation: "standalone" | "continuation",
) {
  return repeat(
    parts,
    (part) => `${part.kind}:${part.key}`,
    (part) => renderStreamGroupPart(part, opts, presentation),
  );
}

export function renderStreamGroupPart(
  part: StreamGroupPart,
  opts: StreamGroupOptions,
  presentation: "standalone" | "continuation",
) {
  if (part.kind === "reading-indicator") {
    return renderChatWorkingIndicator(part, {
      mascot: opts.branding?.mascot,
      workingPhrases: opts.branding?.workingPhrases,
      waitingApproval: opts.waitingApproval === true,
      startupLabel: opts.startupLabel,
      outputTokens: opts.runOutputTokens,
      presentation,
    });
  }
  if (part.kind === "question") {
    const prompt = opts.questionPrompts?.get(part.questionId);
    return prompt ? renderChatQuestionSummary(prompt) : nothing;
  }
  const source = prepareChatMessageRender({
    role: "assistant",
    content: [{ type: "text", text: part.text }],
    timestamp: part.startedAt,
  });
  return renderGroupedMessage(
    source,
    part.key,
    {
      ...opts,
      isStreaming: part.isStreaming,
      entryRef: opts.entryRefFor?.(part.key),
      showReasoning: false,
      // Settled segments can be replied to without transcript IDs or footer actions.
      messageActions: resolveMessageActionDetails(source, {
        messageId: part.key,
        onReply: opts.onReply,
        senderLabel: opts.assistant?.name ?? "Assistant",
      }),
    },
    opts.onOpenSidebar,
  );
}

// One assistant group per contiguous run of streaming items: a reply that
// arrives as several stream segments renders under a single avatar/footer
// instead of flashing a separate avatar+bubble per segment (#63956).
export function renderStreamGroup(parts: StreamGroupPart[], opts: StreamGroupOptions = {}) {
  const { assistant } = opts;
  const name = assistant?.name ?? "Assistant";
  // Footer (sender + time) anchors to the earliest streamed segment; a run that
  // is only the reading indicator has no timestamp and therefore no footer.
  const streamStarts = parts.flatMap((part) => (part.kind === "stream" ? [part.startedAt] : []));
  const footerStartedAt = streamStarts.length > 0 ? Math.min(...streamStarts) : null;
  const active = parts.some(
    (part) => part.kind === "reading-indicator" || (part.kind === "stream" && part.isStreaming),
  );
  // While the agent works with nothing streamed yet the run is pure claw: no
  // avatar next to it - the punching pincer is the whole signal. The avatar
  // arrives with the first stream part unless the presentation opts out.
  const workingOnly = parts.every((part) => part.kind !== "stream");
  const avatar =
    workingOnly || opts.showAssistantAvatar === false
      ? nothing
      : renderChatAvatar("assistant", assistant);
  const groupClass = `chat-group assistant${workingOnly ? " chat-group--working" : ""}${footerStartedAt !== null ? " chat-group--with-footer" : ""}`;

  return html`
    <div class=${groupClass} data-chat-row-key=${parts[0]?.key ?? nothing}>
      ${avatar}
      <div class="chat-group-messages">
        ${renderChatReplyAttribution(parts.find((part) => part.kind === "stream")?.replyToSender)}
        ${renderStreamGroupParts(parts, opts, "standalone")}
      </div>
      ${
        footerStartedAt === null
          ? nothing
          : active
            ? emptyGroupFooter
            : html`
                <div class="chat-group-footer">
                  <div class="chat-group-footer__meta">
                    <span class="chat-sender-name">${name}</span>
                    ${renderChatTimestamp(footerStartedAt)}
                  </div>
                </div>
              `
      }
    </div>
  `;
}

/** A streaming answer already ends its turn: reserve its footer row before the footer content exists. */
export const emptyGroupFooter = html`<div class="chat-group-footer" aria-hidden="true"></div>`;

/** Completed work keeps elapsed time and outcomes above the expandable narration. */
export function renderWorkGroupSummary(
  item: { key: string; durationMs: number | null; groups: readonly MessageGroup[] },
  opts: {
    expanded: boolean;
    onToggle: () => void;
    presentation?: "standalone" | "continuation";
    browserTabPreviews?: unknown;
  },
) {
  const duration = formatDurationCompact(item.durationMs);
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
  const fallback = new Set(
    cards.filter(
      (card) => rawCards.has(card) && (!card.callId || !preparedCallIds.has(card.callId)),
    ),
  );
  const activity: Array<Parameters<typeof describeToolGroup>[0][number]> = [];
  for (const entry of prepared) {
    for (const activityItem of entry.activity) {
      const card = cardsById.get(activityItem.toolCallId ?? activityItem.itemId);
      // Copy only adjusted outcomes; the cached message projection stays untouched.
      activity.push(
        activityItem.status === "blocked" && card && isToolCardSkipped(card)
          ? { ...activityItem, status: "skipped" }
          : activityItem,
      );
    }
  }
  for (const [index, card] of [...fallback].entries()) {
    const outcome = resolveToolCardOutcome(card, false);
    activity.push({
      itemId: `work-summary-raw:${index}`,
      toolCallId: card.callId,
      title: card.name,
      name: card.name,
      status: outcome === "succeeded" ? "completed" : outcome === "unknown" ? undefined : outcome,
    });
  }
  const label = duration ? t("chat.workRun.workedFor", { duration }) : t("chat.workRun.worked");
  const summary = describeToolGroup(activity);
  const total = summary.total;
  const outcomes = summary.outcomes.filter(({ kind }) => kind !== "failed");
  const currentActivity = new Map(
    activity
      .filter((activityItem) => !activityItem.suppressChannelProgress)
      .map((activityItem) => [activityItem.toolCallId ?? activityItem.itemId, activityItem]),
  );
  const visibleCards = cards.filter((card) => {
    const activityItem = card.callId ? currentActivity.get(card.callId) : undefined;
    return (
      fallback.has(card) ||
      Boolean(
        activityItem &&
        !activityItem.hideFromChannelProgress &&
        (!isToolCardSkipped(card) || activityItem.status === "skipped"),
      )
    );
  });
  const toolOutcomes = renderToolOutcomeSummary(visibleCards, true, activity);
  const content = html`
    <div class="chat-activity-group chat-work-group ${opts.expanded ? "is-open" : ""}">
      <button
        class="chat-inline-disclosure chat-activity-group__summary"
        type="button"
        aria-expanded=${String(opts.expanded)}
        @pointerenter=${syncToolDisclosureOverflow}
        @focus=${syncToolDisclosureOverflow}
        @click=${(event: MouseEvent) => {
          if (shouldToggleSelectableDisclosure(event)) {
            opts.onToggle();
          }
        }}
      >
        <span class="chat-tool-disclosure__content">
          <span class="chat-activity-group__label">${label}</span>
        </span>
        ${
          total > 0
            ? html`<span class="chat-work-group__total"
                >·
                ${t(`chat.workRun.toolCalls${total === 1 ? "One" : "Many"}`, { count: String(total) })}</span
              >`
            : nothing
        }
        ${outcomes.map((outcome) => html`<span class="muted">· ${outcome.label}</span>`)}
        ${
          toolOutcomes === nothing
            ? nothing
            : html`<span class="chat-work-group__outcomes">· ${toolOutcomes}</span>`
        }
        <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </button>
      <div class="chat-work-group__separator" aria-hidden="true"></div>
      ${opts.expanded ? nothing : (opts.browserTabPreviews ?? nothing)}
    </div>
  `;
  return opts.presentation === "continuation"
    ? content
    : html`
        <div
          class="chat-group tool chat-group--turn-block chat-group--work"
          data-chat-row-key=${item.key}
        >
          <div class="chat-group-messages">${content}</div>
        </div>
      `;
}

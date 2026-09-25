import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem, MessageGroup } from "../../../lib/chat/chat-types.ts";
import { describeToolGroup, readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
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
        footerStartedAt !== null && !active
          ? html`
              <div class="chat-group-footer">
                <div class="chat-group-footer__meta">
                  <span class="chat-sender-name">${name}</span>
                  ${renderChatTimestamp(footerStartedAt)}
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

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
  const cards = item.groups.flatMap((group) =>
    group.messages.flatMap(({ message }) => extractToolCardsCached(message)),
  );
  const activity = item.groups.flatMap((group) =>
    group.messages.flatMap(({ message }) => readPreparedActivity(message)),
  );
  const label = duration ? t("chat.workRun.workedFor", { duration }) : t("chat.workRun.worked");
  const outcomes = describeToolGroup(activity).outcomes.filter(({ kind }) => kind !== "failed");
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
        ${outcomes.map((outcome) => html`<span class="muted">${outcome.label}</span>`)}
        ${renderToolOutcomeSummary(cards, true, activity.length ? activity : undefined)}
        <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </button>
      <div class="chat-work-group__separator" aria-hidden="true"></div>
      ${opts.expanded ? nothing : (opts.browserTabPreviews ?? nothing)}
    </div>
  `;
  return opts.presentation === "continuation"
    ? content
    : html`
        <div class="chat-group tool chat-group--work" data-chat-row-key=${item.key}>
          <div class="chat-group-messages">${content}</div>
        </div>
      `;
}

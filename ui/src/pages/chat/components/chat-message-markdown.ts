import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatReplyTarget } from "../../../lib/chat/chat-types.ts";
import { readHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import {
  resolveCappedMessageId,
  resolveSourceMessageId,
  type AssistantMessageExpansionState,
} from "../chat-message-recovery.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { extractMessageMediaText } from "./chat-message-media.ts";
import {
  ownReactionEmoji,
  type MessageReactionAction,
  type MessageReactionOptions,
} from "./chat-message-reactions.ts";

registerChatMessageMetadataEnglish();

export type MessageReplyTarget = ChatReplyTarget;

export type MessageActionDetails = {
  /** Source for context copy, independent of footer visibility and reply truncation. */
  copyMarkdown?: string;
  markdown?: string;
  fullMessage?: { messageId: string; state: AssistantMessageExpansionState | undefined };
  replyTarget?: MessageReplyTarget;
  reactionMessageId?: string;
};

// Loading and completion each advance the revision: three automatic attempts.
export const FULL_MESSAGE_RETRY_REVISION_LIMIT = 6;

// Options and action handlers outlive a render; keep this preparation separate from them.
export function prepareChatMessageRender(message: unknown) {
  const normalizedMessage = normalizeMessage(message);
  const displayMarkdown = resolveMessageDisplayMarkdown(message, normalizedMessage);
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  let humanMentions: ReturnType<typeof readHumanMentions>;
  if (record?.role === "user" && metadata?.humanMentions) {
    const source =
      typeof record.content === "string"
        ? record.content
        : Array.isArray(record.content)
          ? record.content
              .flatMap((block: unknown) => {
                const item = asNullableRecord(block);
                return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
              })
              .join("\n")
          : null;
    // Selections belong to submitted bytes, not a stripped envelope or display cap.
    if (source === displayMarkdown) {
      humanMentions = readHumanMentions(displayMarkdown, metadata.humanMentions);
    }
  }
  return { message, normalizedMessage, displayMarkdown, humanMentions };
}

export type ChatMessageRenderPreparation = ReturnType<typeof prepareChatMessageRender>;

// An explicit Markdown value is the displayed expansion, even when it is empty.
export function resolveMessageReplyText(
  message: unknown,
  normalizedMessage = normalizeMessage(message),
  markdown = resolveMessageDisplayMarkdown(message, normalizedMessage),
): string {
  return markdown || extractMessageMediaText(message, normalizedMessage.content);
}

export function resolveMessageActionDetails(
  { message, normalizedMessage, displayMarkdown: previewMarkdown }: ChatMessageRenderPreparation,
  params: {
    messageId: string;
    canFetchFullMessage?: boolean;
    getAssistantMessageExpansion?: (
      messageId: string,
    ) => AssistantMessageExpansionState | undefined;
    onReply?: (target: MessageReplyTarget) => void;
    senderLabel: string;
  },
): MessageActionDetails | null {
  const { messageId: renderMessageId, canFetchFullMessage, onReply, senderLabel } = params;
  const role = normalizeRoleForGrouping(normalizedMessage.role);
  const pendingInput =
    resolveSourceMessageId(message)?.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX) === true;
  const cappedMessageId = canFetchFullMessage ? resolveCappedMessageId(message, role) : undefined;
  const fullMessage = cappedMessageId
    ? { messageId: cappedMessageId, state: params.getAssistantMessageExpansion?.(cappedMessageId) }
    : undefined;
  const expansion = fullMessage?.state;
  const expandedMarkdown = expansion?.status === "loaded" ? expansion.markdown : previewMarkdown;
  const visibleMarkdown =
    role === "assistant" ? stripThinkingTags(expandedMarkdown) : expandedMarkdown;
  const markdown =
    role === "assistant" || role === "user" || pendingInput ? visibleMarkdown : undefined;
  const copyMarkdown = resolveMessageReplyText(message, normalizedMessage, visibleMarkdown);
  const replyText = onReply && !pendingInput ? truncateUtf16Safe(copyMarkdown, 500) : "";
  const sourceMessageId = persistedMessageEntryId(message);
  const reactionMessageId =
    (role === "user" || role === "assistant") && !pendingInput ? sourceMessageId : null;
  if (!copyMarkdown && !markdown && !replyText && !fullMessage && !reactionMessageId) {
    return null;
  }
  return {
    copyMarkdown,
    ...(reactionMessageId ? { reactionMessageId } : {}),
    ...(markdown === undefined ? {} : { markdown }),
    fullMessage,
    ...(replyText
      ? {
          replyTarget: {
            messageId: renderMessageId,
            text: replyText,
            senderLabel,
            ...(sourceMessageId ? { sourceMessageId } : {}),
          },
        }
      : {}),
  };
}

/** Whether `renderMessageActionButtons` renders at least one control for these options. */
export function hasMessageActionButtons(
  details: MessageActionDetails | null | undefined,
  opts: { onReply?: (target: MessageReplyTarget) => void; onReact?: MessageReactionAction },
): details is MessageActionDetails {
  return Boolean(
    details &&
    (details.markdown ||
      (details.replyTarget && opts.onReply) ||
      (details.reactionMessageId && opts.onReact)),
  );
}

export function renderMessageActionButtons(
  details: MessageActionDetails | null | undefined,
  opts: MessageReactionOptions & {
    onReply?: (target: MessageReplyTarget) => void;
  },
) {
  if (!details) {
    return nothing;
  }
  const reactionMessageId = details.reactionMessageId;
  return html`
    ${
      details.replyTarget && opts.onReply
        ? renderReplyButton(details.replyTarget, opts.onReply)
        : nothing
    }
    ${details.markdown ? renderCopyAsMarkdownButton(details.markdown) : nothing}
    ${
      reactionMessageId && opts.onReact
        ? html`<openclaw-message-reaction-picker
            class="chat-reaction-action"
            placement=${opts.reactionPlacement ?? "bottom-start"}
            .activeEmoji=${ownReactionEmoji(opts.messageReactions?.get(reactionMessageId), opts.userId)}
            .onSelect=${(emoji: string, remove: boolean) =>
              opts.onReact?.(reactionMessageId, emoji, remove)}
          ></openclaw-message-reaction-picker>`
        : nothing
    }
  `;
}

export function renderReplyButton(
  target: MessageReplyTarget,
  onReply: (target: MessageReplyTarget) => void,
) {
  return html`
    <openclaw-tooltip .content=${t("chat.messages.reply")}>
      <button
        class="chat-reply-btn"
        type="button"
        aria-label=${t("chat.messages.replyToMessage")}
        @click=${() => onReply(target)}
      >
        ${icons.messageSquare}
      </button>
    </openclaw-tooltip>
  `;
}

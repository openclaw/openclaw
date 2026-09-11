import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { persistedMessageEntryId, type AssistantMessageExpansionState } from "../chat-thread.ts";
import { extractMessageMediaText } from "./chat-message-media.ts";
import { resolveMessageDisplayMarkdown } from "./chat-message-text.ts";

export type MessageReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

export type MessageActionDetails = {
  markdown?: string;
  fullMessage?: { messageId: string; state: AssistantMessageExpansionState | undefined };
  replyTarget?: MessageReplyTarget;
};

// Loading and completion each advance the revision: three automatic attempts.
export const FULL_MESSAGE_RETRY_REVISION_LIMIT = 6;

function resolveSourceMessageId(message: unknown): string | undefined {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  return typeof metadata?.id === "string"
    ? metadata.id
    : typeof record?.messageId === "string"
      ? record.messageId
      : undefined;
}

export function resolveCappedMessageId(message: unknown, role: string): string | undefined {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  const messageId = resolveSourceMessageId(message);
  // Only the Gateway marker proves a display cap; sentinel text can be literal.
  // Pending user inputs share read-only recovery with assistant messages.
  return (normalizeRoleForGrouping(role) === "assistant" ||
    messageId?.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) &&
    !record?.openclawMessageToolMirror &&
    metadata?.truncated === true
    ? messageId
    : undefined;
}

// Options and action handlers outlive a render; keep this preparation separate from them.
export function prepareChatMessageRender(message: unknown) {
  const normalizedMessage = normalizeMessage(message);
  return {
    message,
    normalizedMessage,
    displayMarkdown: resolveMessageDisplayMarkdown(message, normalizedMessage),
  };
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
  const markdown = role === "assistant" || pendingInput ? visibleMarkdown : undefined;
  const replyText =
    onReply && !pendingInput
      ? truncateUtf16Safe(resolveMessageReplyText(message, normalizedMessage, visibleMarkdown), 500)
      : "";
  if (!markdown && !replyText && !fullMessage) {
    return null;
  }
  const sourceMessageId = persistedMessageEntryId(message);
  return {
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

export function renderMessageActionButtons(
  details: MessageActionDetails,
  opts: {
    onReply?: (target: MessageReplyTarget) => void;
  },
) {
  return html`
    ${
      details.replyTarget && opts.onReply
        ? renderReplyButton(details.replyTarget, opts.onReply)
        : nothing
    }
    ${details.markdown ? renderCopyAsMarkdownButton(details.markdown) : nothing}
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

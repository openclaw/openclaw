import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Show } from "solid-js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import { readHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import {
  type AssistantMessageExpansionState,
  resolveCappedMessageId,
  resolveSourceMessageId,
} from "../chat-message-recovery.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import type { MessageActionDetails, MessageReplyTarget } from "./chat-message-markdown.types.ts";
import { extractMessageMediaText } from "./chat-message-media.ts";
import {
  type MessageReactionAction,
  type MessageReactionOptions,
  ownReactionEmoji,
} from "./chat-message-reaction-model.ts";
import { MessageReactionPicker } from "./chat-message-reactions-view.tsx";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

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

export function resolveMessageReplyText(
  message: unknown,
  normalizedMessage: NormalizedMessage,
  markdown: string,
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
  const isConversationMessage = role === "assistant" || role === "user";
  const markdown = isConversationMessage || pendingInput ? visibleMarkdown : undefined;
  const copyMarkdown = resolveMessageReplyText(message, normalizedMessage, visibleMarkdown);
  const replyText = onReply && !pendingInput ? truncateUtf16Safe(copyMarkdown, 500) : "";
  const sourceMessageId = persistedMessageEntryId(message);
  const reactionMessageId = isConversationMessage && !pendingInput ? sourceMessageId : null;
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

type MessageActionOptions = MessageReactionOptions & {
  onReply?: (target: MessageReplyTarget) => void;
};

export function MessageActions(props: {
  details: MessageActionDetails | null | undefined;
  options: MessageActionOptions;
}) {
  return (
    <>
      <Show when={props.details?.replyTarget && props.options.onReply}>
        <ReplyButton target={props.details!.replyTarget!} onReply={props.options.onReply!} />
      </Show>
      <Show when={props.details?.markdown}>
        <LitContent value={renderCopyAsMarkdownButton(props.details!.markdown!)} />
      </Show>
      <Show when={props.details?.reactionMessageId && props.options.onReact}>
        <MessageReactionPicker
          class="chat-reaction-action"
          placement={props.options.reactionPlacement ?? "bottom-start"}
          activeEmoji={ownReactionEmoji(
            props.options.messageReactions?.get(props.details!.reactionMessageId!),
            props.options.userId,
          )}
          onSelect={(emoji: string, remove: boolean) =>
            props.options.onReact?.(props.details!.reactionMessageId!, emoji, remove)
          }
        />
      </Show>
    </>
  );
}

export function ReplyButton(props: {
  target: MessageReplyTarget;
  onReply: (target: MessageReplyTarget) => void;
}) {
  return (
    <openclaw-tooltip prop:content={t("chat.messages.reply")}>
      <button
        class="chat-reply-btn"
        type="button"
        aria-label={t("chat.messages.replyToMessage")}
        onClick={() => props.onReply(props.target)}
      >
        <Icon name="messageSquare" />
      </button>
    </openclaw-tooltip>
  );
}

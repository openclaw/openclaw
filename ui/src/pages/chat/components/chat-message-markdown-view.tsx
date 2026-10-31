import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { onSettled, Show } from "solid-js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { copyMarkdownLabel } from "../../../components/copy-button-state.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatItem, NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import {
  prepareChatMessageRender,
  type ChatMessageRenderPreparation,
} from "../../../lib/chat/message-display.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { assistantMessageCanOwnTurnActions } from "../chat-assistant-reply.ts";
import {
  type AssistantMessageExpansionState,
  resolveCappedMessageId,
  resolveSourceMessageId,
} from "../chat-message-recovery.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import {
  registerMessageActionElements,
  type MessageActionElements,
} from "./chat-message-action-elements.ts";
import type { MessageActionDetails, MessageReplyTarget } from "./chat-message-markdown.types.ts";
import { extractMessageMediaText } from "./chat-message-media.ts";
import {
  hasActionRowReactionPicker,
  type MessageReactionOptions,
} from "./chat-message-reaction-model.ts";
import { MessageReactionPicker } from "./chat-message-reactions-view.tsx";
import { ReadAloud } from "./chat-read-aloud.tsx";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

// Loading and completion each advance the revision: three automatic attempts.
export const FULL_MESSAGE_RETRY_REVISION_LIMIT = 6;

const streamPreparations = new WeakMap<
  Extract<ChatItem, { kind: "stream" }>,
  ChatMessageRenderPreparation
>();

/** The rail and bubble consume the same immutable stream snapshot. */
export function prepareChatStreamRender(part: Extract<ChatItem, { kind: "stream" }>) {
  let prepared = streamPreparations.get(part);
  if (!prepared) {
    prepared = prepareChatMessageRender({
      role: "assistant",
      content: [
        ...(part.thinking ? [{ type: "thinking", thinking: part.thinking }] : []),
        { type: "text", text: part.text },
      ],
      timestamp: part.startedAt,
    });
    streamPreparations.set(part, prepared);
  }
  return prepared;
}

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
  const normalizedRole = normalizeRoleForGrouping(normalizedMessage.role);
  const role =
    normalizedRole === "tool" &&
    asNullableRecord(message)?.role === "assistant" &&
    assistantMessageCanOwnTurnActions(message)
      ? "assistant"
      : normalizedRole;
  const pendingInput =
    resolveSourceMessageId(message)?.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX) === true;
  const cappedMessageId = canFetchFullMessage ? resolveCappedMessageId(message, role) : undefined;
  const fullMessage = cappedMessageId
    ? { messageId: cappedMessageId, state: params.getAssistantMessageExpansion?.(cappedMessageId) }
    : undefined;
  const expansion = fullMessage?.state;
  const expandedMarkdown = expansion?.status === "loaded" ? expansion.markdown : previewMarkdown;
  // Preparation already filtered the preview; loaded full text is a new display input.
  const visibleMarkdown =
    role === "assistant" && expansion?.status === "loaded"
      ? stripThinkingTags(expandedMarkdown)
      : expandedMarkdown;
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
    ...(role === "assistant" && visibleMarkdown ? { readAloudText: visibleMarkdown } : {}),
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

type MessageActionOptions = MessageReactionOptions & {
  onReply?: (target: MessageReplyTarget) => void;
};

// The picker never reports an active emoji here: it only renders while the message has no reactions.
const NO_ACTIVE_REACTIONS: ReadonlySet<string> = new Set();

export function hasMessageActionButtons(
  details: MessageActionDetails | null | undefined,
  opts: MessageActionOptions,
): details is MessageActionDetails {
  return Boolean(
    details &&
    (details.markdown ||
      (details.replyTarget && opts.onReply) ||
      hasActionRowReactionPicker(details.reactionMessageId, opts)),
  );
}

export function MessageActions(props: {
  details: MessageActionDetails | null | undefined;
  options: MessageActionOptions;
  actionOwner?: () => HTMLElement | undefined;
  messageKey?: string;
}) {
  const elements: MessageActionElements = {};
  onSettled(() => {
    const owner = props.actionOwner?.();
    return owner
      ? registerMessageActionElements(owner, () => props.messageKey, elements)
      : undefined;
  });
  return (
    <>
      <Show when={props.details?.replyTarget && props.options.onReply}>
        <ReplyButton target={props.details!.replyTarget!} onReply={props.options.onReply!} />
      </Show>
      <Show when={props.details?.markdown}>
        <CopyButton
          text={props.details!.markdown!}
          idleLabel={copyMarkdownLabel()}
          bare
          ref={(element) => {
            elements.copy = element;
          }}
        />
      </Show>
      <Show when={props.details?.readAloudText}>
        <ReadAloud
          text={props.details!.readAloudText!}
          buttonRef={(element) => {
            elements.readAloud = element;
          }}
        />
      </Show>
      <Show when={hasActionRowReactionPicker(props.details?.reactionMessageId, props.options)}>
        <MessageReactionPicker
          class="chat-reaction-action"
          placement={props.options.reactionPlacement ?? "bottom-start"}
          activeEmoji={NO_ACTIVE_REACTIONS}
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

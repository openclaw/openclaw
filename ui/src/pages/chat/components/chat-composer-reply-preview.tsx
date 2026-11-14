import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatReplyTarget } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { resolveMessageReplyLine } from "./chat-reply-attribution.ts";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";

registerChatMessageMetadataEnglish();

/** The pending reply above the composer, naming its author like the sent reply line will. */
export function ComposerReplyPreview(view: {
  composer: ChatComposerProps;
  target: ChatReplyTarget;
}) {
  const line = createMemo(() => {
    const { composer, target } = view;
    const id = target.sourceMessageId ?? "";
    // The thread's own author projection names a loaded original.
    const message = composer.messages.findLast((entry) => persistedMessageEntryId(entry) === id);
    const senderLabel = target.senderLabel ?? "";
    const loaded = new Map(message ? [[id, { message, messageId: id, senderLabel }]] : []);
    const replyTarget = { kind: "id" as const, id };
    return resolveMessageReplyLine(
      {
        role: "user",
        content: [],
        timestamp: 0,
        replyTarget,
        replyPreview: { text: "", senderLabel },
      },
      createReplyPreviewResolver(loaded, composer),
      composer.userId,
      false,
    );
  });
  const named = () => line().state === "named";
  return (
    <div class="chat-reply-preview composer-context-strip">
      <span class="chat-reply-preview__label composer-context-strip__label">
        <span class="chat-reply-preview__icon composer-context-strip__icon">
          <Icon name="messageSquare" />
        </span>
        <span class="composer-context-strip__label-text">{t("chat.messages.replyingToLabel")}</span>
        <span class="chat-reply-attribution__person">
          <Show when={named()}>
            <ChatAuthorAvatar
              sender={line().sender}
              agentAvatar={line().agentAvatar}
              mediaReadAllowed={view.composer.mediaReadAllowed}
              hideTooltip
            />
          </Show>
          <span class="chat-reply-attribution__name">
            {named() ? line().name : t("chat.messages.message")}
          </span>
        </span>
      </span>
      <span class="chat-reply-preview__text composer-context-strip__text">
        {truncateUtf16Safe(view.target.text, 120)}
        {view.target.text.length > 120 ? "..." : ""}
      </span>
      <button
        type="button"
        class="chat-reply-preview__dismiss composer-context-strip__dismiss"
        onClick={() => view.composer.onClearReply?.()}
        aria-label={t("chat.composer.cancelReply")}
        title={t("chat.composer.cancelReply")}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatReplyTarget } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ReplyLine } from "./chat-reply-attribution.ts";

registerChatMessageMetadataEnglish();

/** The pending reply above the composer, naming its author like the sent reply will. */
export function ComposerReplyPreview(props: {
  target: ChatReplyTarget;
  line?: ReplyLine | null;
  mediaReadAllowed?: boolean;
  onClear?: () => void;
}) {
  const named = () => (props.line?.state === "named" && props.line.name ? props.line : undefined);
  return (
    <div class="chat-reply-preview composer-context-strip composer-context-strip--reply">
      <span class="chat-reply-preview__label composer-context-strip__label">
        <span class="chat-reply-preview__icon composer-context-strip__icon">
          <Icon name="messageSquare" />
        </span>
        <Show
          when={named()}
          fallback={
            <span class="composer-context-strip__label-text">
              {t("chat.messages.replyingTo", {
                name: props.target.senderLabel ?? t("chat.messages.message"),
              })}
            </span>
          }
        >
          {(line) => (
            <>
              <span class="composer-context-strip__label-text">
                {t("chat.messages.replyingToLabel")}
              </span>
              <span
                class="chat-reply-attribution__person chat-reply-preview__person"
                title={line().sender?.name ?? line().name}
              >
                <ChatAuthorAvatar
                  sender={line().sender}
                  agentAvatar={line().agentAvatar}
                  mediaReadAllowed={props.mediaReadAllowed}
                  hideTooltip
                />
                <span class="chat-reply-attribution__name">{line().name}</span>
              </span>
            </>
          )}
        </Show>
      </span>
      <span class="chat-reply-preview__text composer-context-strip__text">
        {truncateUtf16Safe(props.target.text, 120)}
        {props.target.text.length > 120 ? "..." : ""}
      </span>
      <button
        type="button"
        class="chat-reply-preview__dismiss composer-context-strip__dismiss"
        onClick={() => props.onClear?.()}
        aria-label={t("chat.composer.cancelReply")}
        title={t("chat.composer.cancelReply")}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

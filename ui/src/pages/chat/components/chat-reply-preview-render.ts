import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import "../../../styles/chat/reply-preview.css";

export type ReplyPreview = {
  sourceMessageId?: string;
  senderLabel?: string | null;
  text: string;
};

export function renderReplyPreview(
  replyTarget: NormalizedMessage["replyTarget"],
  preview: ReplyPreview | undefined,
  onOpenReply: ((replyToId: string) => void) | undefined,
  onResolveReply: ((replyToId: string) => void) | undefined,
  navigationLoading: boolean,
) {
  if (!replyTarget) {
    return nothing;
  }
  const replyToId = replyTarget.kind === "id" ? replyTarget.id : null;
  const name = preview?.senderLabel?.trim()
    ? preview.senderLabel
    : replyTarget.kind === "current"
      ? t("chat.messages.currentMessage")
      : t("chat.messages.message");
  const content = preview?.text.trim() ?? "";
  const resolveMissingPreview = (element?: Element) => {
    if (element && replyToId && !preview) {
      onResolveReply?.(replyToId);
    }
  };
  const body = html`
    <span class="chat-reply-preview__icon"
      >${
        navigationLoading
          ? html`<span class="session-run-spinner" aria-hidden="true"></span>`
          : icons.messageSquare
      }</span
    >
    <span class="chat-reply-preview__label"> ${t("chat.messages.replyingTo", { name })} </span>
    ${
      content
        ? html`<span class="chat-reply-preview__text"
            >${truncateUtf16Safe(content, 120)}${content.length > 120 ? "..." : ""}</span
          >`
        : nothing
    }
  `;
  if (replyToId && onOpenReply) {
    return html`
      <button
        ${ref(resolveMissingPreview)}
        type="button"
        class="chat-reply-preview chat-reply-preview--message"
        ?disabled=${navigationLoading}
        aria-busy=${navigationLoading ? "true" : "false"}
        @click=${() => onOpenReply(replyToId)}
      >
        ${body}
      </button>
    `;
  }
  return html`
    <div
      ${ref(resolveMissingPreview)}
      class="chat-reply-preview chat-reply-preview--message chat-reply-preview--unavailable"
    >
      ${body}
    </div>
  `;
}

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

export type CommentPreview = { text: string; comment: string };

/** Rendered selection length disambiguates headings without assuming DOM offsets include line breaks. */
export function parseCommentAttachment(value: string): CommentPreview | null {
  const footer =
    /\n\nSource session: [^\n]+\n(?:Source message: [^\n]+\n)?(?:Source entry: [^\n]+\n)?(?:Selected text UTF-16 length: (\d+)\n)?DOM text UTF-16 range: \[(\d+), (\d+)\)$/.exec(
      value,
    );
  const prefix = "Selected text:\n";
  if (!footer || !value.startsWith(prefix)) {
    return null;
  }
  const start = Number(footer[2]);
  const end = Number(footer[3]);
  // Previously sent files only recorded the DOM span; keep their validated boundary.
  const length = footer[1] === undefined ? end - start : Number(footer[1]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    !Number.isSafeInteger(length) ||
    length <= 0
  ) {
    return null;
  }
  const body = value.slice(prefix.length, footer.index);
  const text = body.slice(0, length);
  const rest = body.slice(length);
  const commentPrefix = "\n\nUser comment:\n";
  if (text.length !== length || (rest && !rest.startsWith(commentPrefix))) {
    return null;
  }
  return { text, comment: rest ? rest.slice(commentPrefix.length) : "" };
}

export function renderCommentPreviewRow(
  comment: CommentPreview,
  actions: TemplateResult | typeof nothing = nothing,
) {
  return html`<li class="chat-comment-preview__item">
    <div class="chat-comment-preview__body">
      <span class="muted">${t("chat.messages.annotationSelectedText")}</span>
      <div class="chat-comment-preview__text">${comment.text}</div>
      ${
        comment.comment
          ? html`<span class="muted">${t("chat.messages.annotationUserComment")}</span>
              <div class="chat-comment-preview__text">${comment.comment}</div>`
          : nothing
      }
    </div>
    ${actions}
  </li>`;
}

export function renderCommentPreviewChip(
  count: number,
  content: TemplateResult,
  onReveal?: () => void,
  openOnClick = false,
) {
  return html`<openclaw-tooltip
    class="chat-comment-preview"
    placement="top-start"
    .describe=${false}
    .openOnClick=${openOnClick}
  >
    <span
      class="chat-selection-annotations__chip"
      tabindex="0"
      @pointerenter=${onReveal}
      @focusin=${onReveal}
      @click=${openOnClick ? onReveal : undefined}
    >
      <span aria-hidden="true">${icons.messageSquare}</span>
      ${t(count === 1 ? "chat.messages.annotationCount" : "chat.messages.annotationsCount", { count: String(count) })}
    </span>
    <div
      slot="content"
      class="chat-comment-preview__scroll"
      tabindex="0"
      role="region"
      aria-label=${t("chat.messages.annotations")}
    >
      ${content}
    </div>
  </openclaw-tooltip>`;
}

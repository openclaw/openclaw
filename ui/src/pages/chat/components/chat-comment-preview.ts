import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import { scrollState } from "../../../components/scroll-state.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { renderAttachmentPreviewChip } from "./chat-attachment-preview-chip.ts";
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
      <div
        class="chat-comment-preview__text chat-comment-preview__text--selection"
        .textContent=${comment.text}
      ></div>
      ${
        comment.comment
          ? html`<span class="muted">${t("chat.messages.annotationUserComment")}</span>
              <div
                class="chat-comment-preview__text chat-comment-preview__text--comment"
                tabindex="0"
                role="region"
                aria-label=${t("chat.messages.annotationUserComment")}
                .textContent=${comment.comment}
                ${scrollState()}
              ></div>`
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
  removal?: { onRemove: (event: Event) => void; disabled: boolean },
  elementRef?: (element: Element | undefined) => void,
) {
  return renderAttachmentPreviewChip({
    label: t(count === 1 ? "chat.messages.annotationCount" : "chat.messages.annotationsCount", {
      count: String(count),
    }),
    regionLabel: t("chat.messages.annotations"),
    icon: icons.messageSquare,
    content,
    onReveal,
    openOnClick,
    elementRef,
    removal: removal ? { ...removal, label: t("chat.messages.removeAnnotations") } : undefined,
  });
}

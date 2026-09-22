import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { renderCommentPreviewChip, renderCommentPreviewRow } from "./chat-comment-preview.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

/** The persistent comment owner handles edits from either preview or source marker. */
export function renderChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  const comments = props.attachments?.filter((attachment) => attachment.selectionAnnotation) ?? [];
  const request = (event: Event, id: string, action: "edit" | "delete") => {
    event.currentTarget?.dispatchEvent(
      new CustomEvent("openclaw-comment-action", {
        bubbles: true,
        composed: true,
        detail: { id, action },
      }),
    );
  };
  return comments.length
    ? renderCommentPreviewChip(
        comments.length,
        html`<ol class="chat-comment-preview__list" role="list">
          ${comments.map((attachment, index) =>
            renderCommentPreviewRow(
              attachment.selectionAnnotation!,
              html`<span class="chat-comment-preview__actions">
                <button
                  type="button"
                  aria-label=${t("chat.messages.editAnnotation", { number: String(index + 1) })}
                  ?disabled=${props.disabled || props.readSignal?.aborted}
                  @click=${(event: Event) => request(event, attachment.id, "edit")}
                >
                  ${icons.pencil}
                </button>
                <button
                  type="button"
                  aria-label=${t("chat.messages.deleteAnnotation")}
                  ?disabled=${props.disabled || props.readSignal?.aborted}
                  @click=${(event: Event) => request(event, attachment.id, "delete")}
                >
                  ${icons.trash}
                </button>
              </span>`,
            ),
          )}
        </ol>`,
      )
    : nothing;
}

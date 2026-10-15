import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { renderCommentPreviewChip, renderCommentPreviewRows } from "./chat-comment-preview.tsx";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

export function dispatchChatCommentAction(
  event: Event,
  id: string | undefined,
  action: "edit" | "delete" | "delete-all",
) {
  event.currentTarget?.dispatchEvent(
    new CustomEvent("openclaw-comment-action", {
      bubbles: true,
      composed: true,
      detail: { id, action },
    }),
  );
}

/** The persistent comment owner handles edits from either preview or source marker. */
export function renderChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  const comments = props.attachments?.filter((attachment) => attachment.selectionAnnotation) ?? [];
  return comments.length
    ? renderCommentPreviewChip(
        comments.length,
        renderCommentPreviewRows(
          comments.map((attachment, index) => ({
            comment: attachment.selectionAnnotation!,
            actions: html`<span class="chat-comment-preview__actions">
              ${(["edit", "delete"] as const).map(
                (action) =>
                  html`<button
                    type="button"
                    data-comment-delete=${action === "delete" ? attachment.id : nothing}
                    aria-label=${action === "edit" ? t("chat.messages.editAnnotation", { number: String(index + 1) }) : t("chat.messages.deleteAnnotation")}
                    ?disabled=${props.disabled || props.readSignal?.aborted}
                    @click=${(event: Event) => dispatchChatCommentAction(event, attachment.id, action)}
                  >
                    ${action === "edit" ? icons.pencil : icons.trash}
                  </button>`,
              )}
            </span>`,
          })),
        ),
        undefined,
        {
          onRemove: (event) => dispatchChatCommentAction(event, undefined, "delete-all"),
          disabled: Boolean(props.disabled || props.readSignal?.aborted),
        },
      )
    : nothing;
}

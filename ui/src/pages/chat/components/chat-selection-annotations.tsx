import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { CommentPreviewChip, CommentPreviewRow } from "./chat-comment-preview.tsx";

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

export function ChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  const comments = () =>
    props.attachments?.filter((attachment) => attachment.selectionAnnotation) ?? [];
  const disabled = () => Boolean(props.disabled || props.readSignal?.aborted);
  return (
    <Show when={comments().length > 0}>
      <CommentPreviewChip
        count={comments().length}
        removal={{
          onRemove: (event) => dispatchChatCommentAction(event, undefined, "delete-all"),
          disabled: disabled(),
        }}
      >
        <ol class="chat-comment-preview__list" role="list">
          <For each={comments()} keyed={(attachment) => attachment.id}>
            {(attachment, index) => (
              <Show when={attachment().selectionAnnotation}>
                {(annotation) => (
                  <CommentPreviewRow comment={annotation()}>
                    <span class="chat-comment-preview__actions">
                      <button
                        type="button"
                        aria-label={t("chat.messages.editAnnotation", {
                          number: String(index() + 1),
                        })}
                        disabled={disabled()}
                        onClick={(event) =>
                          dispatchChatCommentAction(event, attachment().id, "edit")
                        }
                      >
                        <Icon name="pencil" />
                      </button>
                      <button
                        type="button"
                        data-comment-delete={attachment().id}
                        aria-label={t("chat.messages.deleteAnnotation")}
                        disabled={disabled()}
                        onClick={(event) =>
                          dispatchChatCommentAction(event, attachment().id, "delete")
                        }
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  </CommentPreviewRow>
                )}
              </Show>
            )}
          </For>
        </ol>
      </CommentPreviewChip>
    </Show>
  );
}

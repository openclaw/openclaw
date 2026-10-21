import { For, Show, untrack } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { CommentPreviewChip, CommentPreviewRow } from "./chat-comment-preview.tsx";

export type ChatCommentAction = {
  id?: string;
  action: "edit" | "delete" | "delete-all";
  anchor?: HTMLElement;
  focusDelete?: (id: string) => void;
};

export function dispatchChatCommentAction(
  event: Event,
  id: string | undefined,
  action: ChatCommentAction["action"],
  context?: Pick<ChatCommentAction, "anchor" | "focusDelete">,
) {
  event.currentTarget?.dispatchEvent(
    new CustomEvent("openclaw-comment-action", {
      bubbles: true,
      composed: true,
      detail: { id, action, ...context },
    }),
  );
}

export function ChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  let preview: HTMLElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  const deleteButtons = new Map<string, HTMLButtonElement>();
  const focusDelete = (id: string) => {
    if (preview?.isConnected && preview.hasAttribute("open")) {
      deleteButtons.get(id)?.focus({ preventScroll: true });
    }
  };
  const comments = () =>
    props.attachments?.filter((attachment) => attachment.selectionAnnotation) ?? [];
  const disabled = () => Boolean(props.disabled || props.readSignal?.aborted);
  return (
    <Show when={comments().length > 0}>
      <CommentPreviewChip
        previewRef={(element) => (preview = element)}
        triggerRef={(element) => (trigger = element)}
        count={comments().length}
        removal={{
          onRemove: (event) => dispatchChatCommentAction(event, undefined, "delete-all"),
          disabled: disabled(),
        }}
      >
        <ol class="chat-comment-preview__list" role="list">
          <For each={comments()} keyed={(attachment) => attachment.id}>
            {(attachment, index) => {
              const initialId = untrack(() => attachment().id);
              const deleteRef = elementRef((element: HTMLButtonElement) => {
                deleteButtons.set(initialId, element);
                return () => {
                  deleteButtons.delete(initialId);
                };
              });
              return (
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
                            dispatchChatCommentAction(event, attachment().id, "edit", {
                              anchor: trigger,
                            })
                          }
                        >
                          <Icon name="pencil" />
                        </button>
                        <button
                          ref={deleteRef}
                          type="button"
                          data-comment-delete={attachment().id}
                          aria-label={t("chat.messages.deleteAnnotation")}
                          disabled={disabled()}
                          onClick={(event) =>
                            dispatchChatCommentAction(event, attachment().id, "delete", {
                              focusDelete,
                            })
                          }
                        >
                          <Icon name="trash" />
                        </button>
                      </span>
                    </CommentPreviewRow>
                  )}
                </Show>
              );
            }}
          </For>
        </ol>
      </CommentPreviewChip>
    </Show>
  );
}

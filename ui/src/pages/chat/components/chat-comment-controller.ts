import { createEffect, createMemo, onCleanup, onSettled } from "solid-js";
import { focusWithoutTooltip } from "../../../components/tooltip.ts";
import type { ChatAttachment, ChatSelectionAnnotation } from "../../../lib/chat/chat-types.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import { releaseDisplacedChatAttachmentPayloads } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { currentAttachments } from "./chat-attachment-draft.ts";
import { stagedAttachmentBytes } from "./chat-attachments.ts";
import { resolveChatCommentAnchor } from "./chat-comment-anchor.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";
import { showChatAnnotationEditor } from "./chat-selection-popup.ts";

type CommentAttachment = ChatAttachment & { selectionAnnotation: ChatSelectionAnnotation };

export function currentChatComments(attachments: readonly ChatAttachment[], sessionKey: string) {
  return attachments.filter((item): item is CommentAttachment =>
    Boolean(
      item.selectionAnnotation &&
      areUiSessionKeysEquivalent(item.selectionAnnotation.sessionKey, sessionKey),
    ),
  );
}

type ChatCommentControllerProps = {
  props: ChatAttachmentControlsProps;
  disabled: boolean;
  sessionKey: string;
  paneId: string;
  presented: boolean;
};

/** Owns comment mutations even when plugins or history errors replace the transcript. */
defineSolidBridge<ChatCommentControllerProps>(
  "openclaw-chat-comment-controller",
  (view, host) => {
    let root: HTMLElement | null = null;
    let editorOwner: AbortController | undefined;
    let editingId: string | undefined;
    let editorAnchor: HTMLElement | undefined;
    let editorObserver: MutationObserver | undefined;
    let positionEditor: (() => void) | undefined;
    let focusFrame: number | undefined;
    host.style.display = "contents";

    const retireEditor = () => {
      editorOwner?.abort();
      editorOwner = undefined;
      editingId = undefined;
      editorAnchor = undefined;
      positionEditor = undefined;
      editorObserver?.disconnect();
      if (focusFrame !== undefined) {
        cancelAnimationFrame(focusFrame);
        focusFrame = undefined;
      }
    };

    function canChange(signal: AbortSignal | undefined) {
      return (
        host.isConnected &&
        view.presented &&
        !view.disabled &&
        !signal?.aborted &&
        view.props.readSignal === signal &&
        Boolean(view.props.onAttachmentsChange)
      );
    }

    function changeAttachments(current: ChatAttachment[], next: ChatAttachment[]) {
      if (view.props.onAttachmentsChange?.(next) === false) {
        releaseDisplacedChatAttachmentPayloads(next, [current]);
        return false;
      }
      releaseDisplacedChatAttachmentPayloads(current, [next]);
      view.props.onRequestUpdate?.();
      return true;
    }

    function visiblePin(id: string) {
      return Array.from(root?.querySelectorAll<HTMLElement>(".chat-comment-pin") ?? []).find(
        (pin) => {
          if (pin.dataset.attachmentId !== id || pin.hidden) {
            return false;
          }
          const bounds = pin.getBoundingClientRect();
          const thread = pin.closest(".chat-thread")?.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            thread &&
            bounds.top >= Math.max(thread.top, 0) &&
            bounds.bottom <= Math.min(thread.bottom, window.innerHeight) &&
            bounds.left >= Math.max(thread.left, 0) &&
            bounds.right <= Math.min(thread.right, window.innerWidth)
          );
        },
      );
    }

    const handleCommentAction = (event: Event) => {
      if (!(event instanceof CustomEvent) || !canChange(view.props.readSignal)) {
        return;
      }
      if (event.detail?.action === "delete-all") {
        event.stopPropagation();
        clearComments();
        return;
      }
      const attachment = currentChatComments(currentAttachments(view.props), view.sessionKey).find(
        (item) => item.id === event.detail?.id,
      );
      if (!attachment) {
        return;
      }
      event.stopPropagation();
      if (event.detail.action === "delete") {
        const preview =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>(".chat-comment-preview--editable")
            : null;
        deleteComment(attachment.id, preview);
      } else if (event.detail.action === "edit" && event.target instanceof HTMLElement) {
        // Opening must not queue a transcript scroll that would dismiss the editor.
        const trigger = event.target
          .closest("openclaw-tooltip")
          ?.querySelector<HTMLElement>(".chat-selection-annotations__trigger");
        editComment(attachment, visiblePin(attachment.id) ?? trigger ?? event.target);
      }
    };

    function focusComposer() {
      root
        ?.querySelector<HTMLElement>(
          "openclaw-plugin-view[data-plugin-composer], .agent-chat__composer-combobox > textarea",
        )
        ?.focus({ preventScroll: true });
    }

    function clearComments() {
      retireEditor();
      const removed = currentChatComments(currentAttachments(view.props), view.sessionKey);
      if (removed.length === 0) {
        return;
      }
      const ids = new Set(removed.map((item) => item.id));
      const current = currentAttachments(view.props);
      changeAttachments(
        current,
        current.filter((item) => !ids.has(item.id)),
      );
      focusComposer();
    }

    function deleteComment(id: string, preview: HTMLElement | null = null) {
      retireEditor();
      const signal = view.props.readSignal;
      const sessionKey = view.sessionKey;
      const comments = currentChatComments(currentAttachments(view.props), sessionKey);
      const index = comments.findIndex((item) => item.id === id);
      const next = comments[index + 1] ?? comments[index - 1];
      const current = currentAttachments(view.props);
      changeAttachments(
        current,
        current.filter((item) => item.id !== id),
      );
      if (!preview || !next) {
        focusComposer();
        return;
      }
      // Wait for the attachment owner to render the renumbered list before moving focus.
      focusFrame = requestAnimationFrame(() => {
        focusFrame = undefined;
        if (
          !canChange(signal) ||
          view.sessionKey !== sessionKey ||
          !preview.isConnected ||
          !preview.hasAttribute("open")
        ) {
          return;
        }
        preview
          .querySelector<HTMLElement>(`[data-comment-delete="${CSS.escape(next.id)}"]`)
          ?.focus({ preventScroll: true });
      });
    }

    const syncEditorAnchor = () => {
      if (!editorAnchor?.isConnected || editorAnchor.hidden) {
        retireEditor();
      } else {
        positionEditor?.();
      }
    };

    function editComment(attachment: CommentAttachment, anchor: HTMLElement) {
      const signal = view.props.readSignal;
      if (!canChange(signal)) {
        return;
      }
      retireEditor();
      editorOwner = new AbortController();
      editingId = attachment.id;
      editorAnchor = anchor;
      positionEditor = showChatAnnotationEditor({
        paneId: view.paneId,
        anchorRect: anchor.getBoundingClientRect(),
        anchorElement: anchor,
        sourceRange: root
          ? resolveChatCommentAnchor(root, attachment.selectionAnnotation)?.range
          : undefined,
        comment: attachment.selectionAnnotation.comment,
        expanded: true,
        readSignal: editorOwner.signal,
        onSave: (comment) => {
          if (!canChange(signal)) {
            return true;
          }
          const current = currentAttachments(view.props);
          const selected = current.find((item) => item.id === attachment.id);
          if (!selected?.selectionAnnotation) {
            return true;
          }
          const replacement = createChatSelectionAttachment(
            { ...selected.selectionAnnotation, comment },
            view.props,
            stagedAttachmentBytes(
              view.props,
              current.filter((item) => item.id !== attachment.id),
            ),
          );
          if (!replacement) {
            return false;
          }
          if (
            !changeAttachments(
              current,
              current.map((item) => (item.id === attachment.id ? replacement : item)),
            )
          ) {
            return false;
          }
          retireEditor();
          focusFrame = requestAnimationFrame(() => {
            focusFrame = undefined;
            if (canChange(signal)) {
              const target = visiblePin(replacement.id) ?? (anchor.isConnected ? anchor : null);
              if (target) {
                focusWithoutTooltip(target);
              } else {
                focusComposer();
              }
            }
          });
          return true;
        },
        onDelete: () => {
          if (canChange(signal)) {
            deleteComment(attachment.id);
          }
        },
        onCancel: () => {
          retireEditor();
          focusWithoutTooltip(anchor);
        },
      });
      if (root) {
        editorObserver ??= new MutationObserver(syncEditorAnchor);
        editorObserver.observe(root, { childList: true, subtree: true, attributes: true });
      }
    }

    // Only the admitted comment set and read scope affect the editor lifetime.
    const readScope = createMemo(() => [view.props.readSignal, view.sessionKey] as const, {
      equals: (previous, next) => previous[0] === next[0] && previous[1] === next[1],
    });
    createEffect(readScope, ([signal]) => {
      retireEditor();
      signal?.addEventListener("abort", retireEditor, { once: true });
      return () => signal?.removeEventListener("abort", retireEditor);
    });
    const editingScope = createMemo(
      () => ({
        attachments: view.props.attachments,
        presented: view.presented,
        disabled: view.disabled,
      }),
      {
        equals: (previous, next) =>
          previous.attachments === next.attachments &&
          previous.presented === next.presented &&
          previous.disabled === next.disabled,
      },
    );
    createEffect(editingScope, () => {
      if (
        !view.presented ||
        view.disabled ||
        (editingId &&
          !currentChatComments(currentAttachments(view.props), view.sessionKey).some(
            (item) => item.id === editingId,
          ))
      ) {
        retireEditor();
      }
    });
    onSettled(() => {
      root = host.closest(".chat-session-rail") ?? host.closest(".chat");
      root?.addEventListener("openclaw-comment-action", handleCommentAction);
    });
    onCleanup(() => {
      root?.removeEventListener("openclaw-comment-action", handleCommentAction);
      root = null;
      retireEditor();
    });
    return null;
  },
  {
    properties: {
      props: { default: {}, attribute: false },
      disabled: { default: false, type: Boolean },
      sessionKey: { default: "" },
      paneId: { default: "" },
      presented: { default: true, type: Boolean },
    },
  },
);

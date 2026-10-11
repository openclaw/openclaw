import { For, createEffect, createMemo, onCleanup, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import { chatCommentLineEnd, resolveChatCommentAnchor } from "./chat-comment-anchor.ts";
import { currentChatComments } from "./chat-comment-controller.ts";
import { dispatchChatCommentAction } from "./chat-selection-annotations.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

type ChatCommentPinsProps = {
  attachments: readonly ChatAttachment[];
  sessionKey: string;
  disabled: boolean;
};

/** Draft attachments own the data; this transcript-local view owns source pins. */
defineSolidBridge<ChatCommentPinsProps>(
  "openclaw-chat-comment-pins",
  (props, host) => {
    let root: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    let frame: number | undefined;
    let observedInner: Element | undefined;
    /** Source bubbles placed by the last layout; null while any pin is unplaced. */
    let anchors: HTMLElement[] | null = null;
    const inputs = createMemo(
      () => ({ attachments: props.attachments, sessionKey: props.sessionKey }),
      {
        equals: (previous, next) =>
          previous.attachments === next.attachments && previous.sessionKey === next.sessionKey,
      },
    );
    const comments = createMemo(() =>
      currentChatComments(inputs().attachments, inputs().sessionKey),
    );

    /** The transcript is top-aligned, so content after every placed source cannot move a pin. */
    function canMovePins(target: Node) {
      return (
        !host.contains(target) &&
        !anchors?.every((bubble) => {
          const position = bubble.compareDocumentPosition(target);
          return (
            (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
            (position &
              (Node.DOCUMENT_POSITION_CONTAINED_BY | Node.DOCUMENT_POSITION_DISCONNECTED)) ===
              0
          );
        })
      );
    }

    const scheduleLayout = () => {
      if (frame !== undefined || !host.isConnected) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = undefined;
        layoutPins();
      });
    };

    function layoutPins() {
      if (!root) {
        return;
      }
      const inner = root.querySelector(".chat-thread-inner");
      if (inner && inner !== observedInner) {
        if (observedInner) {
          resizeObserver?.unobserve(observedInner);
        }
        resizeObserver?.observe(inner);
        observedInner = inner;
      }
      const origin = host.getBoundingClientRect();
      const edge = root.getBoundingClientRect().right - 28;
      const occupied: Array<{ left: number; top: number }> = [];
      const placedAnchors: HTMLElement[] = [];
      let placed = true;
      for (const attachment of comments()) {
        const pin = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
          (item) => item.dataset.attachmentId === attachment.id,
        );
        if (!pin) {
          placed = false;
          continue;
        }
        const anchor = resolveChatCommentAnchor(root, attachment.selectionAnnotation);
        const line = anchor ? chatCommentLineEnd(anchor) : null;
        pin.hidden = !line;
        if (!anchor || !line) {
          placed = false;
          continue;
        }
        placedAnchors.push(anchor.bubble);
        let left = Math.min(line.right + 4, edge) - origin.left;
        let top = line.top + (line.height - 24) / 2 - origin.top;
        while (
          occupied.some((item) => Math.abs(item.left - left) < 24 && Math.abs(item.top - top) < 24)
        ) {
          if (left + 48 <= edge - origin.left) {
            left += 24;
          } else {
            top += 24;
          }
        }
        occupied.push({ left, top });
        pin.style.left = `${left}px`;
        pin.style.top = `${top}px`;
      }
      anchors = placed ? placedAnchors : null;
    }

    onSettled(() => {
      root = host.closest(".chat-thread");
      if (root) {
        resizeObserver = new ResizeObserver(scheduleLayout);
        resizeObserver.observe(root);
        mutationObserver = new MutationObserver((records) => {
          if (records.some((record) => canMovePins(record.target))) {
            scheduleLayout();
          }
        });
        mutationObserver.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
        root.addEventListener("scroll", scheduleLayout, { passive: true });
        scheduleLayout();
      }
    });
    createEffect(comments, scheduleLayout);
    onCleanup(() => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      root?.removeEventListener("scroll", scheduleLayout);
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    });
    return (
      <For each={comments()} keyed={(attachment) => attachment.id}>
        {(attachment, index) => (
          <button
            type="button"
            class="btn primary chat-comment-pin"
            data-attachment-id={attachment().id}
            aria-label={t("chat.messages.editAnnotation", { number: String(index() + 1) })}
            title={
              attachment().selectionAnnotation.comment || attachment().selectionAnnotation.text
            }
            disabled={props.disabled}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              dispatchChatCommentAction(event, attachment().id, "edit");
            }}
          >
            <Icon name="messageSquare" />
          </button>
        )}
      </For>
    );
  },
  {
    properties: {
      attachments: { default: [], attribute: false },
      sessionKey: { default: "" },
      disabled: { default: false, attribute: false },
    },
  },
);

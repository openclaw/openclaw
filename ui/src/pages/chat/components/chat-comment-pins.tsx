import { For, createMemo, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { defineSolidBridge } from "../../../lib/solid-bridge.ts";
import { chatCommentLineEnd, resolveChatCommentAnchor } from "./chat-comment-anchor.ts";
import { currentChatComments } from "./chat-comment-controller.ts";
import { dispatchChatCommentAction } from "./chat-selection-annotations.tsx";
import type { TranscriptMessageElements } from "./chat-transcript-message-elements.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

type ChatCommentPinsProps = {
  threadState?: { commentPins?: ChatCommentPinsHandle };
  transcript?: {
    readonly messageElements: TranscriptMessageElements;
    readonly contentElement: HTMLDivElement | null;
  };
  attachments: readonly ChatAttachment[];
  sessionKey: string;
  disabled: boolean;
};

export type ChatCommentPinsHandle = {
  visiblePin: (id: string) => HTMLButtonElement | undefined;
};
const inputHandlers = new WeakMap<HTMLElement, () => void>();

/** Draft attachments own the data; this transcript-local view owns source pins. */
export const ChatCommentPins = defineSolidBridge<ChatCommentPinsProps>(
  "openclaw-chat-comment-pins",
  (props, host) => {
    let root: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    let observedInner: Element | undefined;
    let disposed = false;
    /** Source bubbles placed by the last layout; null while any pin is unplaced. */
    let anchors: HTMLElement[] | null = null;
    let pins: HTMLButtonElement[] = [];
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
    const handle: ChatCommentPinsHandle = {
      visiblePin: (id) => {
        const thread = root?.getBoundingClientRect();
        if (!thread) {
          return undefined;
        }
        return pins.find((pin) => {
          if (!pin.isConnected || pin.dataset.attachmentId !== id || pin.hidden) {
            return false;
          }
          const bounds = pin.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.top >= Math.max(thread.top, 0) &&
            bounds.bottom <= Math.min(thread.bottom, window.innerHeight) &&
            bounds.left >= Math.max(thread.left, 0) &&
            bounds.right <= Math.min(thread.right, window.innerWidth)
          );
        });
      },
    };

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

    const queueLayout = () => {
      if (!host.isConnected) {
        return;
      }
      scheduleLayout(host, layoutPins);
    };

    function layoutPins() {
      if (!root) {
        return undefined;
      }
      const content = props.transcript?.contentElement;
      const inner = content?.isConnected ? content : undefined;
      if (inner !== observedInner) {
        if (observedInner) {
          resizeObserver?.unobserve(observedInner);
        }
        if (inner) {
          resizeObserver?.observe(inner);
        }
        observedInner = inner;
      }
      const origin = host.getBoundingClientRect();
      const edge = root.getBoundingClientRect().right - 28;
      const occupied: Array<{ pin: HTMLButtonElement; left: number; top: number }> = [];
      const hidden: HTMLButtonElement[] = [];
      const placedAnchors: HTMLElement[] = [];
      let placed = true;
      pins = pins.filter((pin) => pin.isConnected);
      for (const attachment of comments()) {
        const pin = pins.find((item) => item.dataset.attachmentId === attachment.id);
        if (!pin) {
          placed = false;
          continue;
        }
        const anchor = resolveChatCommentAnchor(
          props.transcript?.messageElements.elements.values() ?? [],
          attachment.selectionAnnotation,
        );
        const line = anchor ? chatCommentLineEnd(anchor) : null;
        if (!anchor || !line) {
          hidden.push(pin);
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
        occupied.push({ pin, left, top });
      }
      anchors = placed ? placedAnchors : null;
      return () => {
        for (const pin of hidden) {
          pin.hidden = true;
        }
        for (const { pin, left, top } of occupied) {
          pin.hidden = false;
          pin.style.left = `${left}px`;
          pin.style.top = `${top}px`;
        }
      };
    }

    onSettled(() => {
      inputHandlers.set(host, queueLayout);
      // The parent keys this view by its pane's thread state.
      const initialThreadState = props.threadState;
      if (initialThreadState) {
        initialThreadState.commentPins = handle;
      }
      let disconnect: (() => void) | undefined;
      // Native bridge content settles before its host is inserted by the parent.
      queueMicrotask(() => {
        if (disposed) {
          return;
        }
        root = host.closest(".chat-thread");
        if (root) {
          resizeObserver = new ResizeObserver(queueLayout);
          resizeObserver.observe(root);
          mutationObserver = new MutationObserver((records) => {
            if (records.some((record) => canMovePins(record.target))) {
              queueLayout();
            }
          });
          mutationObserver.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          });
          disconnect = listen(root, "scroll", queueLayout, { passive: true });
          queueLayout();
        }
      });
      return () => {
        inputHandlers.delete(host);
        if (initialThreadState?.commentPins === handle) {
          initialThreadState.commentPins = undefined;
        }
        disposed = true;
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
        disconnect?.();
        cancelLayout(host);
      };
    });
    return (
      <For each={comments()} keyed={(attachment) => attachment.id}>
        {(attachment, index) => (
          <button
            ref={(element) => pins.push(element)}
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
    propertyChanged: (host) => inputHandlers.get(host)?.(),
    properties: {
      threadState: { default: undefined, attribute: false },
      transcript: { default: undefined, attribute: false },
      attachments: { default: [], attribute: false },
      sessionKey: { default: "" },
      disabled: { default: false, attribute: false },
    },
  },
);

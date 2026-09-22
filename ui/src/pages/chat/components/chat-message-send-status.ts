import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { readPendingSendStatus } from "../chat-thread-items.ts";

export type ChatSendStatusActions = {
  onRetryQueuedMessage?: (id: string) => void;
  onDiscardQueuedMessage?: (id: string) => void;
  queuedMessageAction?: { id: string; label?: string; onAction?: () => void };
};

export function renderChatSendStatus(
  status: ReturnType<typeof readPendingSendStatus>,
  actions: ChatSendStatusActions,
) {
  if (!status) {
    return nothing;
  }
  const action =
    actions.queuedMessageAction?.id === status.id ? actions.queuedMessageAction : undefined;
  const reconnecting = status.state === "waiting-reconnect";
  const retry = reconnecting ? undefined : (action?.onAction ?? actions.onRetryQueuedMessage);
  const discard =
    (status.state === "unconfirmed" || reconnecting) && !action
      ? actions.onDiscardQueuedMessage
      : undefined;
  return html`<span
    class="chat-send-status"
    title=${status.error ?? nothing}
    data-send-state=${status.state}
  >
    <span aria-hidden="true">·</span>
    <span
      >${t(
        reconnecting
          ? "chat.queue.states.waitingForReconnect"
          : status.state === "unconfirmed"
            ? "chat.queue.deliveryUnconfirmed"
            : "chat.queue.notSent",
      )}</span
    >
    ${
      retry
        ? html`
            <span aria-hidden="true">·</span>
            <button
              class="chat-send-status__action chat-send-status__retry"
              type="button"
              aria-label=${action?.label ?? t("chat.queue.retryQueuedMessage")}
              @click=${() => retry(status.id)}
            >
              ${action?.label ?? t("chat.queue.retry")}
            </button>
          `
        : nothing
    }
    ${
      discard
        ? html`
            <span aria-hidden="true">·</span>
            <button
              class="chat-send-status__action chat-send-status__discard"
              type="button"
              title=${t("chat.queue.discardPendingMessage")}
              @click=${(event: MouseEvent) => {
                // Chromium may retarget click 2 to the next row after removal.
                if (event.detail <= 1) {
                  discard(status.id);
                }
              }}
            >
              ${t("chat.queue.discard")}
            </button>
          `
        : nothing
    }
  </span>`;
}

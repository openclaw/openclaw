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
    (status.state === "failed" ||
      status.state === "unconfirmed" ||
      status.state === "held" ||
      reconnecting) &&
    !action
      ? actions.onDiscardQueuedMessage
      : undefined;
  const renderAction = (kind: "retry" | "discard", callback: typeof retry) =>
    callback
      ? html`<span class="chat-send-status__part">
          <span aria-hidden="true">·</span>
          <button
            class="chat-send-status__action chat-send-status__${kind}"
            type="button"
            aria-label=${kind === "retry" ? (action?.label ?? t("chat.queue.retryQueuedMessage")) : nothing}
            title=${kind === "discard" ? t("chat.queue.discardPendingMessage") : nothing}
            @click=${(event: MouseEvent) => {
              // Chromium may retarget click 2 to the next row after removal.
              if (kind === "retry" || event.detail <= 1) {
                callback(status.id);
              }
            }}
          >
            ${kind === "retry" ? (action?.label ?? t("chat.queue.retry")) : t("chat.queue.discard")}
          </button>
        </span>`
      : nothing;
  return html`<span
    class="chat-send-status"
    title=${status.error ?? nothing}
    data-send-state=${status.state}
  >
    <span class="chat-send-status__part">
      <span aria-hidden="true">·</span>
      <span
        >${t(
          reconnecting
            ? "chat.queue.states.waitingForReconnect"
            : status.state === "held"
              ? "chat.queue.states.needsReview"
              : status.state === "unconfirmed"
                ? "chat.queue.deliveryUnconfirmed"
                : "chat.queue.notSent",
        )}</span
      >
    </span>
    ${renderAction("retry", retry)} ${renderAction("discard", discard)}
  </span>`;
}

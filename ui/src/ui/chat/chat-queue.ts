import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type { ChatQueueItem } from "../ui-types.ts";

export type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueSteer?: (id: string) => void;
  onQueueRemove: (id: string) => void;
  // Retry handler for items whose transport retries hit
  // CHAT_QUEUE_RETRY_BUDGET — used by the failed-delivery indicator added for
  // the WebChat reconnect message-loss fix (#45952). Optional so embedders
  // that do not surface failed sends still type-check.
  onQueueRetry?: (id: string) => void;
};

export function renderChatQueue(props: ChatQueueProps) {
  if (!props.queue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      <div class="chat-queue__title">Queued (${props.queue.length})</div>
      <div class="chat-queue__list">
        ${props.queue.map(
          (item) => html`
            <div
              class="chat-queue__item ${item.kind === "steered"
                ? "chat-queue__item--steered"
                : ""} ${item.failed ? "chat-queue__item--failed" : ""}"
            >
              <div class="chat-queue__main">
                ${item.kind === "steered"
                  ? html`<span class="chat-queue__badge">Steered</span>`
                  : nothing}
                ${item.failed
                  ? html`<span
                      class="chat-queue__badge chat-queue__badge--failed"
                      role="alert"
                      title="Could not deliver this message after multiple attempts"
                      >Failed to send</span
                    >`
                  : nothing}
                <div class="chat-queue__text">
                  ${item.text ||
                  (item.attachments?.length ? `Image (${item.attachments.length})` : "")}
                </div>
              </div>
              <div class="chat-queue__actions">
                ${item.failed && props.onQueueRetry
                  ? html`
                      <button
                        class="btn chat-queue__retry"
                        type="button"
                        title="Retry sending"
                        aria-label="Retry sending queued message"
                        @click=${() => props.onQueueRetry?.(item.id)}
                      >
                        <span>Retry</span>
                      </button>
                    `
                  : nothing}
                ${props.canAbort &&
                props.onQueueSteer &&
                item.kind !== "steered" &&
                !item.localCommandName &&
                !item.failed
                  ? html`
                      <button
                        class="btn chat-queue__steer"
                        type="button"
                        title="Steer now"
                        aria-label="Steer queued message"
                        @click=${() => props.onQueueSteer?.(item.id)}
                      >
                        ${icons.cornerDownRight}
                        <span>Steer</span>
                      </button>
                    `
                  : nothing}
                <button
                  class="btn chat-queue__remove"
                  type="button"
                  aria-label="Remove queued message"
                  @click=${() => props.onQueueRemove(item.id)}
                >
                  ${icons.x}
                </button>
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

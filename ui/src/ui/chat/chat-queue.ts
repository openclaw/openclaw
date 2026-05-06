import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import { viDashboardText as uiText } from "../vi-dashboard-text.ts";

export type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueSteer?: (id: string) => void;
  onQueueRemove: (id: string) => void;
};

export function renderChatQueue(props: ChatQueueProps) {
  if (!props.queue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      <div class="chat-queue__title">
        ${uiText(`Queued (${props.queue.length})`, `Đang chờ (${props.queue.length})`)}
      </div>
      <div class="chat-queue__list">
        ${props.queue.map(
          (item) => html`
            <div
              class="chat-queue__item ${item.kind === "steered" ? "chat-queue__item--steered" : ""}"
            >
              <div class="chat-queue__main">
                ${item.kind === "steered"
                  ? html`<span class="chat-queue__badge">${uiText("Steered", "Đã lái")}</span>`
                  : nothing}
                <div class="chat-queue__text">
                  ${item.text ||
                  (item.attachments?.length
                    ? uiText(
                        `Image (${item.attachments.length})`,
                        `Ảnh (${item.attachments.length})`,
                      )
                    : "")}
                </div>
              </div>
              <div class="chat-queue__actions">
                ${props.canAbort &&
                props.onQueueSteer &&
                item.kind !== "steered" &&
                !item.localCommandName
                  ? html`
                      <button
                        class="btn chat-queue__steer"
                        type="button"
                        title=${uiText("Steer now", "Lái ngay")}
                        aria-label=${uiText("Steer queued message", "Lái tin nhắn đang chờ")}
                        @click=${() => props.onQueueSteer?.(item.id)}
                      >
                        ${icons.cornerDownRight}
                        <span>${uiText("Steer", "Lái")}</span>
                      </button>
                    `
                  : nothing}
                <button
                  class="btn chat-queue__remove"
                  type="button"
                  aria-label=${uiText("Remove queued message", "Xóa tin nhắn đang chờ")}
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

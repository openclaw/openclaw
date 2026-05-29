import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import {
  applySessionBusyOutcomesToChatQueue,
  isChatQueueItemSteered,
  resolveChatQueueItemOutcomeBadge,
  type ChatQueueOutcomeBadge,
} from "./busy-message-outcome.ts";

export type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueRemove: (id: string) => void;
};

function sendStateLabel(item: ChatQueueItem): string | null {
  switch (item.sendState) {
    case "sending":
      return "Sending";
    case "waiting-reconnect":
      return "Waiting for reconnect";
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

function outcomeBadgeClass(variant: ChatQueueOutcomeBadge["variant"]) {
  switch (variant) {
    case "fallback":
      return "chat-queue__badge chat-queue__badge--fallback";
    case "followup":
      return "chat-queue__badge chat-queue__badge--followup";
    case "steered":
      return "chat-queue__badge chat-queue__badge--steered";
    default:
      return "chat-queue__badge";
  }
}

function itemClass(item: ChatQueueItem): string {
  const outcomeBadge = resolveChatQueueItemOutcomeBadge(item);
  const steered = isChatQueueItemSteered(item);
  const classes = ["chat-queue__item"];
  if (steered || outcomeBadge?.variant === "steered") {
    classes.push("chat-queue__item--steered");
  }
  if (outcomeBadge?.variant === "fallback") {
    classes.push("chat-queue__item--fallback");
  }
  return classes.join(" ");
}

export function renderChatQueue(props: ChatQueueProps) {
  if (!props.queue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      <div class="chat-queue__title">Queued (${props.queue.length})</div>
      <div class="chat-queue__list">
        ${props.queue.map((item) => {
          const stateLabel = sendStateLabel(item);
          const outcomeBadge = resolveChatQueueItemOutcomeBadge(item);
          return html`
            <div class=${itemClass(item)}>
              <div class="chat-queue__main">
                ${outcomeBadge
                  ? html`<span
                      class=${outcomeBadgeClass(outcomeBadge.variant)}
                      title=${outcomeBadge.title}
                      >${outcomeBadge.text}</span
                    >`
                  : nothing}
                ${stateLabel ? html`<span class="chat-queue__badge">${stateLabel}</span>` : nothing}
                <div class="chat-queue__text">
                  ${item.text ||
                  (item.attachments?.length ? `Image (${item.attachments.length})` : "")}
                </div>
                ${item.sendError
                  ? html`<div class="chat-queue__error">${item.sendError}</div>`
                  : nothing}
              </div>
              <div class="chat-queue__actions">
                ${item.sendState === "failed" && props.onQueueRetry
                  ? html`
                      <button
                        class="btn chat-queue__retry"
                        type="button"
                        title=${t("chat.queue.retrySend")}
                        aria-label=${t("chat.queue.retryQueuedMessage")}
                        @click=${() => props.onQueueRetry?.(item.id)}
                      >
                        ${icons.refresh}
                        <span>${t("chat.queue.retry")}</span>
                      </button>
                    `
                  : nothing}
                ${props.canAbort &&
                props.onQueueSteer &&
                !isChatQueueItemSteered(item) &&
                !item.sendState &&
                !item.localCommandName
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
          `;
        })}
      </div>
    </div>
  `;
}

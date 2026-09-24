import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatInputRecoveryEnglish } from "../../../i18n/locales/en-chat-input-recovery.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { formatDateTimeMs } from "../../../lib/format.ts";
import type { ChatQueueRecovery } from "./chat-queue-recovery.types.ts";

registerChatInputRecoveryEnglish();

export function renderChatQueueRecoveryRows(
  recovery: ChatQueueRecovery | undefined,
  leadingIcon: TemplateResult,
) {
  return recovery
    ? repeat(
        recovery.items,
        (input) => input.id,
        (input) => renderRecoveryQueueItem(input, recovery, leadingIcon),
      )
    : nothing;
}

export function renderChatQueueRecoveryFooter(recovery: ChatQueueRecovery | undefined) {
  const hasRecoveryPaging = Boolean(recovery?.paging?.onEarlier || recovery?.paging?.onLatest);
  return html`
    ${recovery?.error ? html`<div class="chat-queue__recovery-error" role="alert">${recovery.error}</div>` : nothing}
    ${
      hasRecoveryPaging
        ? html`<div class="chat-queue__recovery-paging">
            <button
              type="button"
              class="chat-queue__action"
              ?disabled=${recovery?.paging?.loading || !recovery?.paging?.onEarlier}
              @click=${recovery?.paging?.onEarlier}
            >
              ${t("chat.inputRecovery.earlier")}
            </button>
            <button
              type="button"
              class="chat-queue__action"
              ?disabled=${recovery?.paging?.loading || !recovery?.paging?.onLatest}
              @click=${recovery?.paging?.onLatest}
            >
              ${t("chat.inputRecovery.latest")}
            </button>
          </div>`
        : nothing
    }
  `;
}
function renderRecoveryQueueItem(
  input: ChatQueueRecovery["items"][number],
  recovery: ChatQueueRecovery,
  leadingIcon: TemplateResult,
) {
  const normalized = normalizeMessage(input.message);
  const text = extractTextCached(input.message) || t("chat.inputRecovery.attachmentOnly");
  const source =
    normalized.senderSession?.label ?? normalized.senderLabel ?? normalized.sender?.name;
  const date = formatDateTimeMs(input.acceptedAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const busy = recovery.busyIds?.has(input.id) === true;
  return html`<div
    class="chat-queue__item chat-queue__item--no-avatar chat-queue__item--recovery"
    data-chat-recovery-input=${input.id}
    data-recovery-state=${input.state}
  >
    <span class="chat-queue__leading" aria-hidden="true">${leadingIcon}</span>
    <span class="chat-queue__copy">
      <span class="chat-queue__text" title=${text}>${text}</span>
      <span class="chat-queue__badge"
        >${t(input.state === "cancelled" ? "chat.inputRecovery.cancelledStatus" : "chat.inputRecovery.interruptedStatus")}</span
      >
      <span class="chat-queue__recovery-meta">${source ? `${source} · ${date}` : date}</span>
    </span>
    <span class="chat-queue__actions">
      <button
        class="chat-queue__action chat-queue__recovery-send"
        type="button"
        ?disabled=${busy || !recovery.onSend}
        aria-label=${t("chat.inputRecovery.send")}
        @click=${(event: MouseEvent) => {
          if (event.detail <= 1) {
            recovery.onSend?.(input.id);
          }
        }}
      >
        ${icons.arrowUp}<span>${t("chat.inputRecovery.send")}</span>
      </button>
      <button
        class="chat-queue__remove"
        type="button"
        ?disabled=${busy}
        aria-label=${t("chat.inputRecovery.discard")}
        title=${t("chat.inputRecovery.discard")}
        @click=${(event: MouseEvent) => {
          if (event.detail <= 1) {
            recovery.onDiscard(input.id);
          }
        }}
      >
        ${icons.trash}
      </button>
    </span>
  </div>`;
}

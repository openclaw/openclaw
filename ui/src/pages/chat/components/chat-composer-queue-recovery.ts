import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatInputRecoveryEnglish } from "../../../i18n/locales/en-chat-input-recovery.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { formatDateTimeMs } from "../../../lib/format.ts";
import { isChatRecoveryInputSendable } from "../chat-input-recovery-contract.ts";
import { projectChatSystemNotice } from "../chat-system-notice.ts";
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
  const key = `recovery:${input.id}`;
  const notice = projectChatSystemNotice(
    { kind: "message", key, message: input.message },
    undefined,
    {
      status: input.state === "cancelled" ? "cancelled" : "interrupted",
      key: `${key}:state`,
      timestamp: input.acceptedAt,
    },
  ).find((item) => item.kind === "notice" && item.key === key);
  const text =
    notice?.kind === "notice"
      ? (notice.collapsedBody ? notice.label : notice.text) || t("common.system")
      : extractTextCached(input.message) || t("chat.inputRecovery.attachmentOnly");
  const source =
    notice?.kind === "notice"
      ? notice.label
      : (normalized.senderSession?.label ?? normalized.senderLabel ?? normalized.sender?.name);
  const date = formatDateTimeMs(input.acceptedAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const busy = recovery.busyIds?.has(input.id) === true;
  const expanded = recovery.expandedIds?.has(input.id) === true;
  const inspection = recovery.inspections?.get(input.id);
  const sendable = isChatRecoveryInputSendable(input.message);
  return html`<details
    class="chat-queue__recovery-row"
    data-chat-recovery-input=${input.id}
    data-recovery-state=${input.state}
    ?open=${expanded}
    @toggle=${(event: Event) => {
      const details = event.currentTarget;
      if (details instanceof HTMLDetailsElement && details.open !== expanded) {
        recovery.onToggle?.(input.id, details.open);
      }
    }}
  >
    <summary
      class="chat-queue__item chat-queue__item--no-avatar chat-queue__item--recovery"
      aria-label=${`${t("chat.inputRecovery.inspect")}: ${text}`}
    >
      <span class="chat-queue__leading" aria-hidden="true"
        >${recovery.renderDetails ? icons.chevronRight : leadingIcon}</span
      >
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
          ?disabled=${busy || !recovery.onSend || !sendable}
          title=${sendable ? t("chat.inputRecovery.send") : t("chat.inputRecovery.nonUser")}
          aria-label=${t("chat.inputRecovery.send")}
          @click=${(event: MouseEvent) => {
            event.preventDefault();
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
            event.preventDefault();
            if (event.detail <= 1) {
              recovery.onDiscard(input.id);
            }
          }}
        >
          ${icons.trash}
        </button>
      </span>
    </summary>
    ${
      expanded
        ? html`<div class="chat-queue__recovery-detail">
            ${!sendable ? html`<p class="chat-queue__recovery-hint">${t("chat.inputRecovery.nonUser")}</p>` : nothing}
            ${inspection?.status === "loading" ? html`<p role="status">${t("chat.inputRecovery.loading")}</p>` : nothing}
            ${inspection?.status === "error" ? html`<p role="alert">${t("chat.inputRecovery.readFailed")} <button type="button" class="chat-queue__action" @click=${() => recovery.onToggle?.(input.id, true)}>${t("common.retry")}</button></p>` : nothing}
            ${recovery.renderDetails?.(input, inspection)}
          </div>`
        : nothing
    }
  </details>`;
}

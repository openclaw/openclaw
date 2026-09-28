import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { formatDateTimeMs } from "../../../lib/format.ts";
import type { ChatSavedInputs } from "../chat-saved-inputs.ts";
import { projectChatSystemNotice } from "../chat-system-notice.ts";

export function renderChatSavedInputsRows(
  recovery: ChatSavedInputs | undefined,
  renderDetails: (input: ChatSavedInputs["items"][number]) => unknown,
) {
  return recovery
    ? repeat(
        recovery.items,
        (input) => input.id,
        (input) => renderRecoveryQueueItem(input, recovery, renderDetails),
      )
    : nothing;
}

export function renderChatSavedInputsFooter(recovery: ChatSavedInputs | undefined) {
  const hasRecoveryPaging = Boolean(recovery?.earlier || recovery?.latest);
  return html`
    ${recovery?.error ? html`<div class="chat-queue__saved-error" role="alert">${recovery.error}</div>` : nothing}
    ${
      hasRecoveryPaging
        ? html`<div class="chat-queue__saved-paging">
            ${
              recovery?.earlier
                ? html`<button
                    type="button"
                    class="chat-queue__action"
                    ?disabled=${recovery.loading || !recovery.canRead}
                    @click=${() => recovery?.onPage(true)}
                  >
                    ${t("chat.savedInputs.earlier")}
                  </button>`
                : nothing
            }
            ${
              recovery?.latest
                ? html`<button
                    type="button"
                    class="chat-queue__action"
                    ?disabled=${recovery.loading || !recovery.canRead}
                    @click=${() => recovery?.onPage(false)}
                  >
                    ${t("chat.savedInputs.latest")}
                  </button>`
                : nothing
            }
          </div>`
        : nothing
    }
  `;
}
function renderRecoveryQueueItem(
  input: ChatSavedInputs["items"][number],
  recovery: ChatSavedInputs,
  renderDetails: (input: ChatSavedInputs["items"][number]) => unknown,
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
      : extractTextCached(input.message) || t("chat.savedInputs.attachmentOnly");
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
  const expanded = recovery.inspections.has(input.id);
  const inspection = recovery.inspections.get(input.id)?.state;
  return html`<details
    class="chat-queue__saved-row"
    data-chat-saved-input=${input.id}
    data-recovery-state=${input.state}
    ?open=${expanded}
    @toggle=${(event: Event) => {
      const details = event.currentTarget;
      if (details instanceof HTMLDetailsElement && details.open !== expanded) {
        void recovery.onToggle(input, details.open);
      }
    }}
  >
    <summary
      class="chat-queue__item chat-queue__item--no-avatar chat-queue__item--saved"
      aria-label=${`${t("chat.savedInputs.inspect")}: ${text}`}
    >
      <span class="chat-queue__leading" aria-hidden="true">${icons.chevronRight}</span>
      <span class="chat-queue__copy">
        <span class="chat-queue__text" title=${text}>${text}</span>
        <span class="chat-queue__badge"
          >${t(input.state === "cancelled" ? "chat.savedInputs.cancelledStatus" : "chat.savedInputs.interruptedStatus")}</span
        >
        <span class="chat-queue__saved-meta">${source ? `${source} · ${date}` : date}</span>
      </span>
    </summary>
    ${
      expanded
        ? html`<div class="chat-queue__saved-detail">
            ${inspection?.status === "loading" ? html`<p role="status">${t("chat.savedInputs.loading")}</p>` : nothing}
            ${inspection?.status === "error" ? html`<p role="alert">${t("chat.savedInputs.readFailed")} <button type="button" class="chat-queue__action" ?disabled=${!recovery.canRead} @click=${() => recovery.onToggle(input, true)}>${t("common.retry")}</button></p>` : nothing}
            ${renderDetails(input)}
          </div>`
        : nothing
    }
  </details>`;
}

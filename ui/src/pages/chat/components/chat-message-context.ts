import { html, nothing } from "lit";
import { readMessageWorkContext } from "../../../../../src/chat/work-context.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";

registerChatMessageMetadataEnglish();

export function renderMessageWorkContext(message: unknown) {
  const attached = readMessageWorkContext(message);
  if (!attached) {
    return nothing;
  }
  const snapshot = attached.snapshot;
  const fields = ["title", "page", "agentId", "workspace", "file", "selection"] as const;
  return html`
    <details class="chat-context-attachment">
      <summary class="chat-context-attachment__summary">
        <span aria-hidden="true">${icons.layers}</span>
        ${t("chat.messages.attachedContext.label")}
        <span class="chat-context-attachment__chevron" aria-hidden="true"
          >${icons.chevronRight}</span
        >
      </summary>
      <div class="chat-context-attachment__body">
        <p>${t("chat.messages.attachedContext.captured")}</p>
        <dl>
          ${fields.map((field) =>
            snapshot[field]
              ? html`<dt>${t(`chat.messages.attachedContext.${field}`)}</dt>
                  <dd>${snapshot[field]}</dd>`
              : nothing,
          )}
        </dl>
        <details class="chat-context-attachment__technical">
          <summary>${t("chat.messages.attachedContext.technical")}</summary>
          <pre>${JSON.stringify(snapshot, null, 2)}</pre>
        </details>
        <p>${t("chat.messages.attachedContext.reference")}</p>
      </div>
    </details>
  `;
}

import { html, nothing, type TemplateResult } from "lit";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { clampText } from "../../../lib/format.ts";

export function renderChatErrorNotice({
  error,
  action = nothing,
  displayError = formatWebUiIconErrorText(error),
  runId,
  historical = false,
}: {
  error: string;
  action?: TemplateResult | typeof nothing;
  displayError?: string;
  runId?: string;
  historical?: boolean;
}) {
  const lines = displayError
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim());
  const [firstLine = ""] = lines;
  const summary = clampText(firstLine);
  const hasDetails = Boolean(runId) || lines.some((line) => line !== "" && line !== summary);
  // Keep the bounded summary readable without opening the technical details.
  return html`
    <div
      class="chat-composer-neighbor-card chat-composer-neighbor-card--danger chat-error ${historical ? "chat-error--historical" : ""}"
      role=${historical ? nothing : "alert"}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
        >${icons.alertTriangle}</span
      >
      ${
        hasDetails
          ? html`<details class="chat-error__content">
              <summary class="chat-error__summary">
                <strong>${summary}</strong>
                <span>${t("chat.details")}</span>
                <span class="chat-error__chevron" aria-hidden="true">${icons.chevronDown}</span>
                ${renderCopyButton(error, t("chat.copyError"))}
              </summary>
              <pre class="chat-error__diagnostic" tabindex="0" aria-label=${t("chat.errorDetails")}>
${displayError}</pre>
              ${
                runId
                  ? html`<div class="chat-error__run">
                      <span>${t("chat.errorRunId")}: <code>${runId}</code></span>
                      ${renderCopyButton(runId, t("chat.copyErrorRunId"))}
                      <p>${t("chat.errorRunLogHint")}</p>
                    </div>`
                  : nothing
              }
            </details>`
          : html`<span class="chat-error__content"
              ><strong>${summary}</strong>${renderCopyButton(error, t("chat.copyError"))}</span
            >`
      }
      ${action}
    </div>
  `;
}

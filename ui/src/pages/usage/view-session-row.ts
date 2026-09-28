import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { renderAgentRowChip } from "../../components/agent-row-chip.ts";
import { handleCopyButton } from "../../components/copy-button.ts";
import { t } from "../../i18n/index.ts";

export function renderSessionBarRow(props: {
  sessionKey: string;
  displayLabel: string;
  meta: string[];
  agentId: string | undefined;
  valueLabel: string;
  isSelected: boolean;
  onSelect: (event: MouseEvent) => void;
}) {
  const { sessionKey, displayLabel, meta, agentId, valueLabel, isSelected, onSelect } = props;
  return html`
    <div
      class="session-bar-row ${isSelected ? "selected" : ""}"
      @click=${(event: MouseEvent) => {
        if (event.target instanceof Element && event.target.closest("button")) {
          return;
        }
        onSelect(event);
      }}
      title="${sessionKey}"
    >
      <button
        type="button"
        class="session-bar-selection"
        aria-label=${displayLabel}
        aria-pressed=${isSelected ? "true" : "false"}
        @click=${onSelect}
      >
        <span class="session-bar-label">
          <span class="session-bar-title">${displayLabel}</span>
          ${agentId ? renderAgentRowChip(agentId) : nothing}
          ${
            meta.length > 0
              ? html`<span class="session-bar-meta">${meta.join(" · ")}</span>`
              : nothing
          }
        </span>
      </button>
      <div class="session-bar-actions">
        ${keyed(
          displayLabel,
          html`<button
            type="button"
            class="btn btn--sm btn--ghost"
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              void handleCopyButton(event, displayLabel, t("usage.sessions.copy"));
            }}
          >
            <span data-copy-label>${t("usage.sessions.copy")}</span>
          </button>`,
        )}
        <div class="session-bar-value">${valueLabel}</div>
      </div>
    </div>
  `;
}

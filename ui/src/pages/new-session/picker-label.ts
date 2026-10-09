import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";

export function renderPickerLabel(icon: TemplateResult, label: string, summary?: string) {
  return html`
    <span class="new-session-page__target-icon" aria-hidden="true">${icon}</span>
    <span class="new-session-page__trigger-label">${label}</span>
    ${summary ? html`<span class="new-session-page__trigger-summary">${summary}</span>` : nothing}
    <span
      class="new-session-page__trigger-chevron new-session-page__trigger-chevron--desktop"
      aria-hidden="true"
      >${icons.chevronDown}</span
    >
    <span
      class="new-session-page__trigger-chevron new-session-page__trigger-chevron--mobile"
      aria-hidden="true"
      >${icons.chevronsUpDown}</span
    >
  `;
}

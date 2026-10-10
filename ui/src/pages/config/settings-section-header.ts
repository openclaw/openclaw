import { html } from "lit";

export function renderSettingsSectionHeader(title: string) {
  return html`<div class="settings-section__header">
    <h2 class="settings-section__heading">${title}</h2>
  </div>`;
}

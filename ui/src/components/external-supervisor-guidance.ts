import { html, nothing } from "lit";
import type { ExternalSupervisorGuidance } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { renderCopyButton } from "./copy-button.ts";

export function renderExternalSupervisorGuidance(
  guidance: ExternalSupervisorGuidance | null | undefined,
) {
  if (!guidance) {
    return nothing;
  }
  return html`<div class="external-supervisor-guidance">
    <p>${t("updates.externalSupervisor.managedBy", { name: guidance.name })}</p>
    ${guidance.runFrom ? html`<p>${t("updates.externalSupervisor.runFrom", { location: guidance.runFrom })}</p>` : nothing}
    <div class="exec-approval-command mono">
      <code translate="no">${guidance.command}</code>
      ${renderCopyButton(guidance.command, t("updates.externalSupervisor.copyCommand"))}
    </div>
  </div>`;
}

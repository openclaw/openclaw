import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";

export function renderAgentPanelAction(label: string, disabled: boolean, onClick: () => void) {
  return html`
    <button class="btn btn--sm" ?disabled=${disabled} @click=${onClick}>${label}</button>
  `;
}

export function renderAgentPanelFacts(
  facts: ReadonlyArray<readonly [string, string | TemplateResult] | null>,
) {
  return html`<dl class="settings-kv">
    ${facts.map((fact) =>
      fact
        ? html`<dt>${t(fact[0])}</dt>
            <dd>${fact[1]}</dd>`
        : nothing,
    )}
  </dl>`;
}

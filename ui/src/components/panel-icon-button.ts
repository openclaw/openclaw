import { html, nothing, type TemplateResult } from "lit";

export function renderPanelIconButton(params: {
  label: string;
  icon: TemplateResult;
  onClick: () => void;
  className: string;
  title?: string;
  disabled?: boolean;
  busy?: boolean;
  newTab?: boolean;
}) {
  return html`<button
    class=${params.className}
    type="button"
    ?data-new-tab-action=${params.newTab}
    title=${params.title ?? params.label}
    aria-label=${params.label}
    aria-busy=${params.busy ?? nothing}
    ?disabled=${params.disabled}
    @click=${params.onClick}
  >
    ${params.icon}
  </button>`;
}

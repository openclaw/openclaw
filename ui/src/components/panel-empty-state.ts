import { html, nothing, type TemplateResult } from "lit";
import type { PanelEmptyStateElement } from "./solid/panel-empty-state.tsx";
import "./solid/panel-empty-state.tsx";

export function renderPanelEmptyState(params: {
  icon: TemplateResult;
  heading: string;
  description: string;
  action?: TemplateResult | typeof nothing;
}) {
  return html`<openclaw-panel-empty-state
    .heading=${params.heading}
    .description=${params.description}
  >
    ${params.icon}${
      params.action != null && params.action !== nothing
        ? html`<span slot="action">${params.action}</span>`
        : nothing
    }
  </openclaw-panel-empty-state>`;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-panel-empty-state": PanelEmptyStateElement;
  }
}

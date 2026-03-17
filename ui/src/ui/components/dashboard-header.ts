import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { titleForTab, type Tab } from "../navigation.js";

@customElement("dashboard-header")
export class DashboardHeader extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() tab: Tab = "overview";

  override render() {
    const label = titleForTab(this.tab);

    return html`
      <div class="dashboard-header">
        <nav class="dashboard-header__breadcrumb" aria-label="Breadcrumb">
          <button
            type="button"
            class="dashboard-header__breadcrumb-link"
            @click=${() => this.dispatchEvent(new CustomEvent("navigate", { detail: "overview", bubbles: true, composed: true }))}
          >
            OpenClaw
          </button>
          <span class="dashboard-header__breadcrumb-sep" aria-hidden="true">›</span>
          <span class="dashboard-header__breadcrumb-current" aria-current="page">${label}</span>
        </nav>
        <div class="dashboard-header__actions">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

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
        <div class="dashboard-header__breadcrumb">
          <span
            class="dashboard-header__breadcrumb-link"
            @click=${() => this.dispatchEvent(new CustomEvent("navigate", { detail: "overview", bubbles: true, composed: true }))}
          >
            OpenClaw
          </span>
          <span class="dashboard-header__breadcrumb-sep">›</span>
          <span class="dashboard-header__breadcrumb-current">${label}</span>
        </div>
        <div class="dashboard-header__actions">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

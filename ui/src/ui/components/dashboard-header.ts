import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { subtitleForTab, titleForTab, type Tab } from "../navigation.js";

@customElement("dashboard-header")
export class DashboardHeader extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() tab: Tab = "overview";

  override render() {
    const label = titleForTab(this.tab);
    const subtitle = subtitleForTab(this.tab);

    return html`
      <div class="dashboard-header">
        <div class="dashboard-header__content">
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
          ${subtitle ? html`<span class="dashboard-header__subtitle-sep">•</span>
          <div class="dashboard-header__subtitle">${subtitle}</div>` : nothing}
        </div>
        <div class="dashboard-header__actions">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

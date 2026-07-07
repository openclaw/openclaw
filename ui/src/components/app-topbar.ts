import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import "./dashboard-header.ts";
import "./tooltip.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export class AppTopbar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) routeId?: NavigationRouteId;
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) agentLabel = "";
  @property({ attribute: false }) navDrawerOpen = false;
  @property({ attribute: false }) navCollapsed = false;
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) onToggleDrawer?: (trigger: HTMLElement) => void;
  @property({ attribute: false }) onToggleCollapse?: () => void;
  @property({ attribute: false }) onToggleTerminal?: () => void;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) overviewHref = "";
  @property({ attribute: false }) terminalAvailable = false;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private readonly handleNavigate = (event: CustomEvent<NavigationRouteId>) => {
    this.onNavigate?.(event.detail);
  };

  override render() {
    // Two sidebar toggles share one slot: the collapse toggle drives the
    // persistent desktop rail, the drawer toggle drives the ≤1100px slide-over.
    // CSS shows exactly one of them per viewport (layout.mobile.css).
    const collapseLabel = this.navCollapsed ? t("nav.expand") : t("nav.collapse");
    const drawerLabel = this.navDrawerOpen ? t("nav.collapse") : t("nav.expand");
    return html`
      <header
        class="topbar"
        ?inert=${this.onboarding}
        aria-hidden=${this.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <openclaw-tooltip .content=${collapseLabel}>
            <button
              type="button"
              class="topbar-icon-btn topbar-sidebar-toggle"
              @click=${() => this.onToggleCollapse?.()}
              aria-label=${collapseLabel}
              aria-expanded=${String(!this.navCollapsed)}
            >
              ${icons.panelLeft}
            </button>
          </openclaw-tooltip>
          <openclaw-tooltip .content=${drawerLabel}>
            <button
              type="button"
              class="topbar-icon-btn topbar-nav-toggle"
              @click=${(event: MouseEvent) =>
                this.onToggleDrawer?.(event.currentTarget as HTMLElement)}
              aria-label=${drawerLabel}
              aria-expanded=${String(this.navDrawerOpen)}
            >
              ${icons.panelLeft}
            </button>
          </openclaw-tooltip>
          <div class="topnav-shell__content">
            <dashboard-header
              .routeId=${this.routeId}
              .basePath=${this.basePath}
              .agentLabel=${this.agentLabel}
              .overviewHref=${this.overviewHref}
              @navigate=${this.handleNavigate}
            ></dashboard-header>
          </div>
          <div class="topnav-shell__actions">
            ${this.terminalAvailable
              ? html`
                  <openclaw-tooltip .content=${t("terminal.toggle")}>
                    <button
                      class="topbar-icon-btn"
                      type="button"
                      @click=${() => this.onToggleTerminal?.()}
                      aria-label=${t("terminal.toggle")}
                    >
                      ${icons.terminal}
                    </button>
                  </openclaw-tooltip>
                `
              : nothing}
          </div>
        </div>
      </header>
    `;
  }
}

if (!customElements.get("openclaw-app-topbar")) {
  customElements.define("openclaw-app-topbar", AppTopbar);
}

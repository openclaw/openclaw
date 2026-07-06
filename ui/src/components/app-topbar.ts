import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ThemeMode } from "../app/theme.ts";
import "./dashboard-header.ts";
import "./theme-mode-toggle.ts";
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
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) routeOwnsHeader = false;
  @property({ attribute: false }) headerError: string | null = null;
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) navCollapsed = false;
  @property({ attribute: false }) onToggleDrawer?: (trigger: HTMLElement) => void;
  @property({ attribute: false }) onOpenPalette?: () => void;
  @property({ attribute: false }) onToggleSidebar?: () => void;
  @property({ attribute: false }) onToggleTerminal?: () => void;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) overviewHref = "";
  @property({ attribute: false }) searchDisabled = false;
  @property({ attribute: false }) terminalAvailable = false;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private readonly handleNavigate = (event: CustomEvent<NavigationRouteId>) => {
    this.onNavigate?.(event.detail);
  };

  override render() {
    const drawerLabel = this.navDrawerOpen ? t("nav.collapse") : t("nav.expand");
    const paletteLabel = t("chat.commandPaletteTitle");
    return html`
      <header
        class="topbar"
        ?inert=${this.onboarding}
        aria-hidden=${this.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <openclaw-tooltip .content=${drawerLabel}>
            <button
              type="button"
              class="sidebar-menu-trigger topbar-nav-toggle"
              @click=${(event: MouseEvent) =>
                this.onToggleDrawer?.(event.currentTarget as HTMLElement)}
              aria-label=${drawerLabel}
              aria-expanded=${this.navDrawerOpen}
            >
              <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.menu}</span>
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
            <openclaw-tooltip .content=${paletteLabel}>
              <button
                class="topbar-icon-btn topbar-search"
                ?disabled=${this.searchDisabled || !this.onOpenPalette}
                @click=${() => this.onOpenPalette?.()}
                aria-label=${t("chat.openCommandPalette")}
              >
                ${icons.search}
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${this.navCollapsed ? t("nav.expand") : t("nav.collapse")}>
              <button
                class="topbar-icon-btn topbar-sidebar-toggle"
                type="button"
                @click=${() => this.onToggleSidebar?.()}
                aria-label=${this.navCollapsed ? t("nav.expand") : t("nav.collapse")}
                aria-expanded=${String(!this.navCollapsed)}
              >
                ${this.navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}
              </button>
            </openclaw-tooltip>
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
            <div class="topbar-status">
              ${this.routeOwnsHeader && this.headerError
                ? html`<div class="pill danger">${this.headerError}</div>`
                : nothing}
              <openclaw-theme-mode-toggle .mode=${this.themeMode}></openclaw-theme-mode-toggle>
            </div>
          </div>
        </div>
      </header>
    `;
  }
}

if (!customElements.get("openclaw-app-topbar")) {
  customElements.define("openclaw-app-topbar", AppTopbar);
}

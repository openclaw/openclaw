import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ThemeMode } from "../app/theme.ts";
import "./dashboard-header.ts";
import "./theme-mode-toggle.ts";
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
  @property({ attribute: false }) onToggleDrawer?: () => void;
  @property({ attribute: false }) onOpenPalette?: () => void;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) overviewHref = "";
  @property({ attribute: false }) searchDisabled = false;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private readonly handleNavigate = (event: CustomEvent<NavigationRouteId>) => {
    this.onNavigate?.(event.detail);
  };

  override render() {
    return html`
      <header
        class="topbar"
        ?inert=${this.onboarding}
        aria-hidden=${this.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <button
            type="button"
            class="sidebar-menu-trigger topbar-nav-toggle"
            @click=${() => this.onToggleDrawer?.()}
            title="${this.navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-label="${this.navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-expanded=${this.navDrawerOpen}
          >
            <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.menu}</span>
          </button>
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
            <button
              class="topbar-search"
              ?disabled=${this.searchDisabled || !this.onOpenPalette}
              @click=${() => this.onOpenPalette?.()}
              title=${t("chat.commandPaletteTitle")}
              aria-label=${t("chat.openCommandPalette")}
            >
              <span class="topbar-search__label">${t("common.search")}</span>
              <kbd class="topbar-search__kbd">⌘K</kbd>
            </button>
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

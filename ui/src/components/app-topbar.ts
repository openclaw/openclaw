import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import "./dashboard-header.ts";
import "./tooltip.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

// Mirrors the layout.mobile.css breakpoint where the sidebar becomes a
// slide-over drawer; the one topbar toggle switches behavior there.
const NAV_DRAWER_MEDIA_QUERY = "(max-width: 1100px)";

class AppTopbar extends LitElement {
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

  private drawerMedia?: MediaQueryList;
  private drawerMediaCleanup?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
    if (typeof globalThis.matchMedia === "function") {
      const media = globalThis.matchMedia(NAV_DRAWER_MEDIA_QUERY);
      this.drawerMedia = media;
      // Older WebViews expose only the legacy addListener API (see the same
      // pattern in app/bootstrap.ts).
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", this.handleDrawerMediaChange);
        this.drawerMediaCleanup = () =>
          media.removeEventListener("change", this.handleDrawerMediaChange);
      } else if (typeof media.addListener === "function") {
        media.addListener(this.handleDrawerMediaChange);
        this.drawerMediaCleanup = () => media.removeListener(this.handleDrawerMediaChange);
      }
    }
  }

  override disconnectedCallback() {
    this.drawerMediaCleanup?.();
    this.drawerMediaCleanup = undefined;
    this.drawerMedia = undefined;
    super.disconnectedCallback();
  }

  private readonly handleDrawerMediaChange = () => {
    this.requestUpdate();
  };

  private get drawerMode(): boolean {
    return this.drawerMedia?.matches ?? false;
  }

  private readonly handleNavigate = (event: CustomEvent<NavigationRouteId>) => {
    this.onNavigate?.(event.detail);
  };

  private readonly handleToggleSidebar = (event: MouseEvent) => {
    if (this.drawerMode) {
      this.onToggleDrawer?.(event.currentTarget as HTMLElement);
    } else {
      this.onToggleCollapse?.();
    }
  };

  override render() {
    // One toggle, viewport-dependent behavior: it drives the persistent rail
    // collapse on desktop and the slide-over drawer at drawer breakpoints.
    const sidebarOpen = this.drawerMode ? this.navDrawerOpen : !this.navCollapsed;
    const toggleLabel = sidebarOpen ? t("nav.collapse") : t("nav.expand");
    return html`
      <header
        class="topbar"
        ?inert=${this.onboarding}
        aria-hidden=${this.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <openclaw-tooltip .content=${toggleLabel}>
            <button
              type="button"
              class="topbar-icon-btn topbar-nav-toggle"
              @click=${this.handleToggleSidebar}
              aria-label=${toggleLabel}
              aria-expanded=${String(sidebarOpen)}
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

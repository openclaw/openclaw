import { html } from "lit";
import { property } from "lit/decorators.js";
import { isSessionsHubRoute } from "../app-navigation.ts";
import type { RouteId } from "../app-routes.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";

type TabBarRoute = "chat" | "sessions" | "activity";

const TAB_BAR_ROUTES: readonly {
  route: TabBarRoute;
  icon: keyof typeof icons;
  labelKey: string;
}[] = [
  { route: "chat", icon: "messageSquare", labelKey: "tabs.chat" },
  { route: "sessions", icon: "fileText", labelKey: "tabs.sessions" },
  { route: "activity", icon: "activity", labelKey: "tabs.activity" },
];

/** Thumb-reachable primary navigation for the mobile-nav shell. Renders only in
 * that shell state (app-host gates it); CSS hides it in short landscape where the
 * viewport has no vertical room. The Menu tab reuses the topbar hamburger's drawer
 * toggle so both entry points open the exact same nav drawer. */
class MobileTabBar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) activeRouteId: RouteId = "chat";
  @property({ attribute: false }) navDrawerOpen = false;
  @property({ attribute: false }) onNavigate?: (routeId: RouteId) => void;
  @property({ attribute: false }) onOpenMenu?: (trigger: HTMLElement) => void;

  private isRouteActive(route: TabBarRoute): boolean {
    if (this.navDrawerOpen) {
      // While the drawer is open the Menu tab owns the active state.
      return false;
    }
    if (route === "sessions") {
      return isSessionsHubRoute(this.activeRouteId);
    }
    return this.activeRouteId === route;
  }

  override render() {
    const menuLabel = t("nav.menu");
    return html`
      <nav class="mobile-tab-bar" aria-label=${menuLabel}>
        ${TAB_BAR_ROUTES.map((tab) => {
          const active = this.isRouteActive(tab.route);
          return html`
            <button
              type="button"
              class="mobile-tab-bar__tab ${active ? "mobile-tab-bar__tab--active" : ""}"
              aria-current=${active ? "page" : "false"}
              @click=${() => this.onNavigate?.(tab.route)}
            >
              <span class="mobile-tab-bar__icon" aria-hidden="true">${icons[tab.icon]}</span>
              <span class="mobile-tab-bar__label">${t(tab.labelKey)}</span>
            </button>
          `;
        })}
        <button
          type="button"
          class="mobile-tab-bar__tab ${this.navDrawerOpen ? "mobile-tab-bar__tab--active" : ""}"
          aria-expanded=${String(this.navDrawerOpen)}
          @click=${(event: MouseEvent) => this.onOpenMenu?.(event.currentTarget as HTMLElement)}
        >
          <span class="mobile-tab-bar__icon" aria-hidden="true">${icons.menu}</span>
          <span class="mobile-tab-bar__label">${menuLabel}</span>
        </button>
      </nav>
    `;
  }
}

if (!customElements.get("openclaw-mobile-tab-bar")) {
  customElements.define("openclaw-mobile-tab-bar", MobileTabBar);
}

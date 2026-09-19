// Sidebar footer identity menu, split out of app-sidebar-agent-menu.ts to
// keep that module inside the TS LOC ratchet. Shares the sidebar menu focus
// helpers and help submenu with the agent menu.
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { nativeGatewaysCapability } from "../app/native-gateways.runtime.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-catalog.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import type { PresenceViewer } from "../lib/presence-users.ts";
import {
  DEBUG_OVERLAY_SHORTCUT_LABEL,
  requestDebugOverlayToggle,
} from "../pages/debug/debug-overlay-contract.ts";
import {
  closeMenuAfterOwnDropdownHide,
  COMMAND_VALUE_PREFIX,
  LINK_VALUE_PREFIX,
  moveSidebarMenuFocus,
  renderSidebarHelpMenu,
} from "./app-sidebar-agent-menu.ts";
import { icons } from "./icons.ts";
import "./sidebar-build-chip.ts";
import "./viewer-facepile.ts";
import { syncDropdownItemRadio, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type SidebarIdentityMenuParams = {
  position: { x: number; bottom: number; width: number };
  canPairDevice: boolean;
  basePath: string;
  gatewayVersion: string | null;
  updateAttentionDismissed: boolean;
  profileViewer?: PresenceViewer;
  offline: boolean;
  themeMode: ThemeMode;
  triggerWidth: number;
  onTabAway: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  onPairMobile: () => void;
  onRetryConnect?: () => void;
};

function renderIdentityGateways(onClose: SidebarIdentityMenuParams["onClose"]) {
  const capability = nativeGatewaysCapability();
  if (!capability) {
    return nothing;
  }
  const snapshot = capability.snapshot;
  const current = snapshot?.gateways.find((gateway) => gateway.id === snapshot.currentId);
  return html`
    <div class="sidebar-customize-menu__title">${t("nav.gateway.sectionLabel")}</div>
    ${snapshot?.gateways.map((gateway, index) => {
      const selected = gateway.id === snapshot.currentId;
      const healthLabel = {
        ok: t("nav.gateway.connected"),
        error: t("nav.gateway.unreachable"),
        unknown: t("nav.gateway.unknown"),
      }[gateway.health];
      const openWindow = (event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
          capability.openWindow(gateway.id);
          onClose(false);
        }
      };
      return html`<wa-dropdown-item
        class="sidebar-customize-menu__item"
        value=${`gateway:${encodeURIComponent(gateway.id)}`}
        role="menuitemradio"
        aria-checked=${String(selected)}
        ${ref((element) => syncDropdownItemRadio(element, selected))}
        @click=${openWindow}
        @contextmenu=${openWindow}
      >
        <span
          slot="icon"
          class="sidebar-gateway-health"
          data-health=${gateway.health}
          role="img"
          aria-label=${healthLabel}
        ></span>
        <span class="sidebar-customize-menu__text">${gateway.name}</span>
        <span slot="details" class="sidebar-gateway-details">
          ${
            gateway.isPrimary
              ? html`<span class="sidebar-gateway-primary">${t("nav.gateway.primaryTag")}</span>`
              : nothing
          }
          ${
            !selected && index < 9
              ? html`<kbd class="session-menu__shortcut" aria-hidden="true">⌘${index + 1}</kbd>`
              : nothing
          }
          ${
            selected
              ? html`<span class="sidebar-gateway-check" aria-hidden="true">${icons.check}</span>`
              : nothing
          }
        </span>
      </wa-dropdown-item>`;
    })}
    ${
      current?.canPromote
        ? html`<wa-dropdown-item
            class="sidebar-customize-menu__item"
            value="command:gateway-set-primary"
          >
            <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.star}</span>
            <span class="sidebar-customize-menu__text">${t("nav.gateway.setPrimary")}</span>
          </wa-dropdown-item>`
        : nothing
    }
    <wa-dropdown-item class="sidebar-customize-menu__item" value="command:gateway-settings">
      <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.server}</span>
      <span class="sidebar-customize-menu__text">${t("nav.gateway.openSettings")}</span>
    </wa-dropdown-item>
    <div class="sidebar-customize-menu__separator" role="separator"></div>
  `;
}

export function renderSidebarIdentityMenu(params: SidebarIdentityMenuParams) {
  const position = params.position;
  const profileName = params.profileViewer?.name ?? params.profileViewer?.email ?? t("nav.owner");
  const avatarUser = {
    id: "owner",
    watchedSessions: [],
    ...params.profileViewer,
    name: profileName,
  };
  const profileEmail =
    params.profileViewer?.email && params.profileViewer.email !== profileName
      ? params.profileViewer.email
      : null;
  return html`
    <wa-dropdown
      class="sidebar-customize-menu sidebar-identity-menu"
      style=${`--sidebar-identity-menu-min-width: ${params.triggerWidth}px`}
      .open=${true}
      placement="top-start"
      .distance=${0}
      aria-label=${t("profilePage.identity.menuLabel")}
      @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
        event.preventDefault();
        const item = event.detail.item;
        if (item.dataset.nativeNavigation) {
          delete item.dataset.nativeNavigation;
          params.onClose(false);
          return;
        }
        const value = item.value;
        if (!value) {
          return;
        }
        params.onClose(false);
        const capability = nativeGatewaysCapability();
        if (value.startsWith("gateway:")) {
          const id = decodeURIComponent(value.slice("gateway:".length));
          if (id !== capability?.snapshot?.currentId) {
            capability?.select(id);
          }
          return;
        }
        if (value.startsWith(LINK_VALUE_PREFIX)) {
          openExternalUrlSafe(decodeURIComponent(value.slice(LINK_VALUE_PREFIX.length)));
          return;
        }
        switch (value) {
          case `${COMMAND_VALUE_PREFIX}gateway-set-primary`: {
            const current = capability?.snapshot?.gateways.find(
              (gateway) => gateway.id === capability.snapshot?.currentId,
            );
            if (current?.canPromote) {
              capability?.setPrimary(current.id);
            }
            break;
          }
          case `${COMMAND_VALUE_PREFIX}gateway-settings`:
            capability?.openSettings();
            break;
          case `${COMMAND_VALUE_PREFIX}profile`:
            params.onNavigate("profile", { hash: "#settings-profile-identity" });
            break;
          case `${COMMAND_VALUE_PREFIX}settings`:
            params.onNavigate("appearance");
            break;
          case `${COMMAND_VALUE_PREFIX}usage`:
            params.onNavigate("usage");
            break;
          case `${COMMAND_VALUE_PREFIX}pair-mobile`:
            params.onPairMobile();
            break;
          case `${COMMAND_VALUE_PREFIX}apps`:
            params.onNavigate("apps");
            break;
          case `${COMMAND_VALUE_PREFIX}debug-overlay`:
            requestDebugOverlayToggle();
            break;
          case `${COMMAND_VALUE_PREFIX}retry-connect`:
            params.onRetryConnect?.();
            break;
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (!moveSidebarMenuFocus(event)) {
          trackDropdownKeyboardDismissal(event, params.onTabAway);
        }
      }}
      @wa-after-hide=${(event: Event) => closeMenuAfterOwnDropdownHide(event, params.onClose)}
    >
      <button
        slot="trigger"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        aria-label=${t("profilePage.identity.menuLabel")}
        style="position: fixed; left: ${position.x}px; bottom: ${position.bottom}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
      ></button>
      <wa-dropdown-item
        class="sidebar-customize-menu__item sidebar-identity-menu__header"
        value="command:profile"
      >
        <span slot="icon" class="sidebar-identity-menu__avatar" aria-hidden="true">
          <openclaw-viewer-avatar .user=${avatarUser} variant="footer"></openclaw-viewer-avatar>
        </span>
        <span class="sidebar-identity-menu__identity">
          <span class="sidebar-identity-menu__name" title=${profileName}>${profileName}</span>
          ${
            profileEmail
              ? html`<span class="sidebar-identity-menu__email" title=${profileEmail}
                  >${profileEmail}</span
                >`
              : nothing
          }
        </span>
      </wa-dropdown-item>
      <div class="sidebar-customize-menu__separator" role="separator"></div>
      ${renderIdentityGateways(params.onClose)}
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:settings">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.settings}</span>
        <span class="sidebar-customize-menu__text">${t("nav.settings")}</span>
        <kbd slot="details" class="session-menu__shortcut" aria-hidden="true"
          >${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.appearanceSettings)}</kbd
        >
      </wa-dropdown-item>
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:usage">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.coins}</span>
        <span class="sidebar-customize-menu__text">${titleForRoute("usage")}</span>
      </wa-dropdown-item>
      <div class="sidebar-customize-menu__separator" role="separator"></div>
      <wa-dropdown-item
        class="sidebar-customize-menu__item sidebar-pair-mobile"
        value="command:pair-mobile"
        ?disabled=${!params.canPairDevice}
        title=${params.canPairDevice ? nothing : t("devices.pairing.adminRequired")}
      >
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.smartphone}</span>
        <span class="sidebar-customize-menu__text">${t("devices.pairing.button")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:apps">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.layoutGrid}</span>
        <span class="sidebar-customize-menu__text">${t("agentChip.getApps")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="sidebar-customize-menu__item" value="command:debug-overlay">
        <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons.activity}</span>
        <span class="sidebar-customize-menu__text">${t("debug.overlay.title")}</span>
        <span slot="details" class="session-menu__shortcut" aria-hidden="true"
          >${DEBUG_OVERLAY_SHORTCUT_LABEL}</span
        >
      </wa-dropdown-item>
      <div class="sidebar-customize-menu__separator" role="separator"></div>
      ${renderSidebarHelpMenu()}
      ${
        params.offline
          ? html`<div class="sidebar-customize-menu__separator" role="separator"></div>
              <wa-dropdown-item
                class="sidebar-customize-menu__item sidebar-identity-menu__retry"
                value="command:retry-connect"
              >
                <span class="sidebar-customize-menu__text">${t("connection.retryNow")}</span>
              </wa-dropdown-item>`
          : nothing
      }
      <div class="sidebar-customize-menu__separator" role="separator"></div>
      <div class="sidebar-identity-menu__footer">
        <openclaw-sidebar-build-chip
          .variant=${"identity"}
          .basePath=${params.basePath}
          .gatewayVersion=${params.gatewayVersion}
          .updateAttentionDismissed=${params.updateAttentionDismissed}
          .onNavigate=${(routeId: "about") => {
            params.onClose();
            params.onNavigate(routeId);
          }}
        ></openclaw-sidebar-build-chip>
        <span class="sidebar-mode-switch">
          <openclaw-theme-mode-toggle .mode=${params.themeMode}></openclaw-theme-mode-toggle>
        </span>
      </div>
    </wa-dropdown>
  `;
}

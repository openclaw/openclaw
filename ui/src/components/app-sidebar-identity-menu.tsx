import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import type { JSX } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { nativeGatewaysCapability } from "../app/native-gateways.runtime.ts";
import type { ThemeMode } from "../app/theme.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../lib/keyboard-shortcut-contract.ts";
import type { PresenceViewer } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { requestDebugOverlayToggle } from "../pages/debug/debug-overlay-contract.ts";
import {
  closeMenuAfterOwnDropdownHide,
  COMMAND_VALUE_PREFIX,
  consumeSidebarMenuSelection,
  moveSidebarMenuFocus,
  renderSidebarHelpMenu,
} from "./app-sidebar-agent-menu.tsx";
import { renderSidebarMenuAction } from "./app-sidebar-nav-menus.tsx";
import { SidebarBuildChip } from "./sidebar-build-chip.tsx";
import { Icon } from "./solid/icon.tsx";
import { Kbd, KeyboardShortcut } from "./solid/kbd.tsx";
import { renderMenuTrigger } from "./solid/menu-trigger.tsx";
import "./viewer-facepile.ts";
import { syncDropdownItemRadio, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type SidebarIdentityMenuParams = {
  position: { x: number; bottom: number; width: number };
  nativeGatewaySnapshot: NativeGatewaysSnapshot | null;
  canPairDevice: boolean;
  basePath: string;
  gatewayVersion: string | null;
  updateAttentionDismissed: boolean;
  profileViewer?: PresenceViewer;
  canRetryConnection: boolean;
  themeMode: ThemeMode;
  triggerWidth: number;
  onTabAway: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  onPairMobile: () => void;
  onRetryConnect?: () => void;
};

function renderIdentityGateways(
  snapshot: () => NativeGatewaysSnapshot | null,
  onClose: SidebarIdentityMenuParams["onClose"],
): JSX.Element {
  const capability = nativeGatewaysCapability();
  if (!capability) {
    return undefined;
  }
  const current = createMemo(() =>
    snapshot()?.gateways.find((gateway) => gateway.id === snapshot()?.currentId),
  );
  return (
    <>
      <div class="sidebar-customize-menu__title">{t("nav.gateway.sectionLabel")}</div>
      <For each={snapshot()?.gateways} keyed={(gateway) => gateway.id}>
        {(gateway, index) => {
          const selected = () => gateway().id === snapshot()?.currentId;
          const healthLabel = () =>
            ({
              ok: t("nav.gateway.connected"),
              error: t("nav.gateway.unreachable"),
              unknown: t("nav.gateway.unknown"),
            })[gateway().health];
          const openWindow = (event: MouseEvent) => {
            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();
              event.stopPropagation();
              capability.openWindow(gateway().id);
              onClose(false);
            }
          };
          return (
            <wa-dropdown-item
              class="sidebar-customize-menu__item"
              value={`gateway:${encodeURIComponent(gateway().id)}`}
              role="menuitemradio"
              aria-checked={selected() ? "true" : "false"}
              ref={(element) => syncDropdownItemRadio(element, selected())}
              onClick={openWindow}
              onContextMenu={openWindow}
            >
              <span
                slot="icon"
                class="sidebar-gateway-health"
                data-health={gateway().health}
                role="img"
                aria-label={healthLabel()}
              />
              <span class="sidebar-customize-menu__text">{gateway().name}</span>
              <span slot="details" class="sidebar-gateway-details">
                {gateway().isPrimary ? (
                  <span class="sidebar-gateway-primary">{t("nav.gateway.primaryTag")}</span>
                ) : undefined}
                {!selected() && index() < 9 ? (
                  <Kbd
                    {...{
                      className: "session-menu__shortcut",
                      ariaHidden: true,
                    }}
                    keys={["⌘", String(index() + 1)]}
                  />
                ) : undefined}
                {selected() ? (
                  <span class="sidebar-gateway-check" aria-hidden="true">
                    {<Icon name="check" />}
                  </span>
                ) : undefined}
              </span>
            </wa-dropdown-item>
          );
        }}
      </For>
      {current()?.canPromote
        ? renderSidebarMenuAction(
            "command:gateway-set-primary",
            t("nav.gateway.setPrimary"),
            "star",
          )
        : undefined}
      {renderSidebarMenuAction("command:gateway-settings", t("nav.gateway.openSettings"), "server")}
      <div class="sidebar-customize-menu__separator" role="separator" />
    </>
  );
}

export function renderSidebarIdentityMenu(params: SidebarIdentityMenuParams): JSX.Element {
  const position = params.position;
  const profileName = () =>
    params.profileViewer?.name ?? params.profileViewer?.email ?? t("nav.owner");
  const avatarUser = createMemo(() => ({
    id: "owner",
    watchedSessions: [],
    ...params.profileViewer,
    name: profileName(),
  }));
  const profileEmail = () =>
    params.profileViewer?.email && params.profileViewer.email !== profileName()
      ? params.profileViewer.email
      : null;
  return (
    <wa-dropdown
      class="sidebar-customize-menu sidebar-identity-menu"
      style={{ "--sidebar-identity-menu-min-width": `${params.triggerWidth}px` }}
      prop:open={true}
      placement="top-start"
      prop:distance={0}
      aria-label={t("profilePage.identity.menuLabel")}
      onWa-select={(event: WaSelectEvent) => {
        const value = consumeSidebarMenuSelection(event, params.onClose);
        if (!value) {
          return;
        }
        const capability = nativeGatewaysCapability();
        if (value.startsWith("gateway:")) {
          const id = decodeURIComponent(value.slice("gateway:".length));
          if (id !== capability?.snapshot?.currentId) {
            capability?.select(id);
          }
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
      onKeyDown={(event: KeyboardEvent) => {
        if (!moveSidebarMenuFocus(event)) {
          trackDropdownKeyboardDismissal(event, params.onTabAway);
        }
      }}
      onWa-after-hide={(event: Event) => closeMenuAfterOwnDropdownHide(event, params.onClose)}
    >
      {renderMenuTrigger(
        {
          get x() {
            return position.x;
          },
          get y() {
            return position.bottom;
          },
        },
        t("profilePage.identity.menuLabel"),
        "bottom",
      )}
      <wa-dropdown-item
        class="sidebar-customize-menu__item sidebar-identity-menu__header"
        value="command:profile"
      >
        <span slot="icon" class="sidebar-identity-menu__avatar" aria-hidden="true">
          <openclaw-viewer-avatar prop:user={avatarUser()} variant="footer" />
        </span>
        <span class="sidebar-identity-menu__identity">
          <span class="sidebar-identity-menu__name" title={profileName()}>
            {profileName()}
          </span>
          {profileEmail() ? (
            <span class="sidebar-identity-menu__email" title={profileEmail() ?? undefined}>
              {profileEmail()}
            </span>
          ) : undefined}
        </span>
      </wa-dropdown-item>
      <div class="sidebar-customize-menu__separator" role="separator" />
      {renderIdentityGateways(() => params.nativeGatewaySnapshot, params.onClose)}
      {renderSidebarMenuAction("command:settings", t("nav.settings"), "settings", {
        get details() {
          return (
            <KeyboardShortcut
              {...{
                slot: "details",
                className: "session-menu__shortcut",
                ariaHidden: true,
              }}
              combo={KEYBOARD_SHORTCUT_COMBOS.appearanceSettings}
            />
          );
        },
      })}
      {renderSidebarMenuAction("command:usage", titleForRoute("usage"), "coins")}
      <div class="sidebar-customize-menu__separator" role="separator" />
      {renderSidebarMenuAction("command:pair-mobile", t("devices.pairing.button"), "smartphone", {
        className: "sidebar-pair-mobile",
        get disabled() {
          return !params.canPairDevice;
        },
        get title() {
          return params.canPairDevice ? undefined : t("devices.pairing.adminRequired");
        },
      })}
      {renderSidebarMenuAction("command:apps", t("agentChip.getApps"), "layoutGrid")}
      {renderSidebarMenuAction("command:debug-overlay", t("debug.overlay.title"), "activity", {
        get details() {
          return (
            <KeyboardShortcut
              {...{
                slot: "details",
                className: "session-menu__shortcut",
                ariaHidden: true,
              }}
              combo={KEYBOARD_SHORTCUT_COMBOS.debugOverlay}
            />
          );
        },
      })}

      <div class="sidebar-customize-menu__separator" role="separator" />
      {renderSidebarHelpMenu()}
      {params.canRetryConnection ? (
        <>
          <div class="sidebar-customize-menu__separator" role="separator" />
          <wa-dropdown-item
            class="sidebar-customize-menu__item sidebar-identity-menu__retry"
            value="command:retry-connect"
          >
            <span class="sidebar-customize-menu__text">{t("connection.retryNow")}</span>
          </wa-dropdown-item>
        </>
      ) : undefined}
      <div class="sidebar-customize-menu__separator" role="separator" />
      <div class="sidebar-identity-menu__footer">
        <SidebarBuildChip
          variant={"identity"}
          basePath={params.basePath}
          gatewayVersion={params.gatewayVersion}
          updateAttentionDismissed={params.updateAttentionDismissed}
          onNavigate={(routeId: "about") => {
            params.onClose();
            params.onNavigate(routeId);
          }}
        />
        <span class="sidebar-mode-switch">
          <openclaw-theme-mode-toggle prop:mode={params.themeMode} prop:menuItem={true} />
        </span>
      </div>
    </wa-dropdown>
  );
}

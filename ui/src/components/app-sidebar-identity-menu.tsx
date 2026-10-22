import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { nativeGatewaysCapability } from "../app/native-gateways.runtime.ts";
import type { ThemeMode } from "../app/theme.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../lib/keyboard-shortcut-contract.ts";
import type { PresenceViewer } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { requestDebugOverlayToggle } from "../pages/debug/debug-overlay-contract.ts";
import { SidebarDropdown, renderSidebarMenuAction } from "./app-sidebar-nav-menus.tsx";
import { SidebarBuildChip } from "./sidebar-build-chip.tsx";
import {
  COMMAND_VALUE_PREFIX,
  renderSidebarHelpMenu,
  selectSidebarHelpLink,
} from "./sidebar-identity-menu-links.tsx";
import { Icon } from "./solid/icon.tsx";
import { Kbd, KeyboardShortcut } from "./solid/kbd.tsx";
import { createMenuControls, type MenuEntry, type MenuItem } from "./solid/menu.tsx";
import "./viewer-facepile.ts";
import { ThemeModeToggle } from "./theme-mode-toggle.tsx";

type SidebarIdentityMenuParams = {
  position: { x: number; bottom: number; width: number; placement?: "right-end" };
  anchor?: HTMLElement;
  tabFocusTarget?: (backward: boolean) => HTMLElement | undefined;
  nativeGatewaySnapshot: NativeGatewaysSnapshot | null;
  canPairDevice: boolean;
  basePath: string;
  gatewayVersion: string | null;
  updateAvailable: boolean;
  profileViewer?: PresenceViewer;
  canRetryConnection: boolean;
  themeMode: ThemeMode;
  onThemeChange?: (mode: ThemeMode, element: HTMLElement) => void;
  triggerWidth: number;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  onPairMobile: () => void;
  onRetryConnect?: () => void;
};

// The slot shares the command icon column so dots, glyphs, and labels line up.
function renderGatewayHealth(health: NativeGatewaysSnapshot["gateways"][number]["health"]) {
  return (
    <span class="sidebar-gateway-health-slot">
      <span
        class="sidebar-gateway-health"
        data-health={health}
        role="img"
        aria-label={
          {
            ok: t("nav.gateway.connected"),
            error: t("nav.gateway.unreachable"),
            unknown: t("nav.gateway.unknown"),
          }[health]
        }
      />
    </span>
  );
}

function renderIdentityGateways(
  snapshot: NativeGatewaysSnapshot | null,
  onClose: SidebarIdentityMenuParams["onClose"],
): MenuEntry[] {
  const capability = nativeGatewaysCapability();
  if (!capability) {
    return [];
  }
  const current = snapshot?.gateways.find((gateway) => gateway.id === snapshot.currentId);
  const gateways: MenuEntry[] = [
    ...(snapshot?.gateways ?? []).map((gateway, index): MenuItem => {
      const selected = gateway.id === snapshot?.currentId;
      const openWindow = (event: MouseEvent) => {
        if (capability.openWindow && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          capability.openWindow(gateway.id);
          onClose(false);
        }
      };
      return {
        id: `gateway:${encodeURIComponent(gateway.id)}`,
        label: gateway.name,
        type: "radio",
        checked: selected,
        class: "sidebar-customize-menu__item",
        attributes: { onClick: openWindow, onContextMenu: openWindow },
        icon: renderGatewayHealth(gateway.health),
        content: <span class="sidebar-customize-menu__text">{gateway.name}</span>,
        details: (
          <span class="sidebar-gateway-details">
            {gateway.isPrimary ? (
              <span class="sidebar-gateway-primary">{t("nav.gateway.primaryTag")}</span>
            ) : undefined}
            {capability.openWindow && !selected && index < 9 ? (
              <Kbd class="session-menu__shortcut" ariaHidden keys={["⌘", String(index + 1)]} />
            ) : undefined}
            {selected ? (
              <span class="sidebar-gateway-check" aria-hidden="true">
                <Icon name="check" />
              </span>
            ) : undefined}
          </span>
        ),
      };
    }),
    ...(current?.canPromote
      ? [
          renderSidebarMenuAction(
            "command:gateway-set-primary",
            t("nav.gateway.setPrimary"),
            "star",
          ),
        ]
      : []),
    renderSidebarMenuAction("command:gateway-settings", t("nav.gateway.openSettings"), "settings"),
  ];
  return [
    {
      kind: "content",
      id: "gateway-title",
      content: <div class="sidebar-customize-menu__title">{t("nav.gateway.sectionLabel")}</div>,
    },
    {
      id: "command:gateways",
      label: current?.name ?? t("nav.gateway.sectionLabel"),
      class: "sidebar-customize-menu__item",
      icon: current ? renderGatewayHealth(current.health) : undefined,
      details: current?.isPrimary ? (
        <span class="sidebar-gateway-primary">{t("nav.gateway.primaryTag")}</span>
      ) : undefined,
      children: gateways,
    },
    {
      kind: "content",
      id: "gateway-separator",
      content: <div class="sidebar-customize-menu__separator" role="separator" />,
    },
  ];
}

export function renderSidebarIdentityMenu(params: SidebarIdentityMenuParams): JSX.Element {
  const controls = createMenuControls();
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
  const items = createMemo<MenuEntry[]>(() => {
    const help = renderSidebarHelpMenu();
    return [
      {
        id: "command:profile",
        label: profileName(),
        class: "sidebar-customize-menu__item sidebar-identity-menu__header",
        icon: (
          <span class="sidebar-identity-menu__avatar" aria-hidden="true">
            <openclaw-viewer-avatar prop:user={avatarUser()} variant="footer" />
          </span>
        ),
        content: (
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
        ),
      },
      {
        kind: "content",
        id: "profile-separator",
        content: <div class="sidebar-customize-menu__separator" role="separator" />,
      },
      ...renderIdentityGateways(params.nativeGatewaySnapshot, params.onClose),
      renderSidebarMenuAction("command:settings", t("nav.settings"), "settings", {
        details: (
          <KeyboardShortcut
            class="session-menu__shortcut"
            ariaHidden
            combo={KEYBOARD_SHORTCUT_COMBOS.appearanceSettings}
          />
        ),
      }),
      {
        ...renderSidebarMenuAction("command:updates", titleForRoute("updates"), "download", {
          details: params.updateAvailable ? (
            <span
              class="agent-select__badge sidebar-identity-menu__update-badge"
              aria-hidden="true"
            >
              {t("updates.sidebar.availableBadge")}
            </span>
          ) : undefined,
        }),
        label: params.updateAvailable
          ? `${titleForRoute("updates")}. ${t("updates.sidebar.availableTitle")}`
          : titleForRoute("updates"),
      },
      renderSidebarMenuAction("command:usage", titleForRoute("usage"), "coins"),
      {
        kind: "content",
        id: "usage-separator",
        content: <div class="sidebar-customize-menu__separator" role="separator" />,
      },
      renderSidebarMenuAction("command:pair-mobile", t("devices.pairing.button"), "smartphone", {
        className: "sidebar-pair-mobile",
        disabled: !params.canPairDevice,
        title: params.canPairDevice ? undefined : t("devices.pairing.adminRequired"),
      }),
      ...(!document.documentElement.classList.contains("openclaw-native-macos")
        ? [renderSidebarMenuAction("command:apps", t("agentChip.getApps"), "layoutGrid")]
        : []),
      renderSidebarMenuAction("command:debug-overlay", t("debug.overlay.title"), "activity", {
        details: (
          <KeyboardShortcut
            class="session-menu__shortcut"
            ariaHidden
            combo={KEYBOARD_SHORTCUT_COMBOS.debugOverlay}
          />
        ),
      }),
      {
        kind: "content",
        id: "help-separator",
        content: <div class="sidebar-customize-menu__separator" role="separator" />,
      },
      ...(help ? [help] : []),
      ...(params.canRetryConnection
        ? [
            {
              kind: "content" as const,
              id: "retry-separator",
              content: <div class="sidebar-customize-menu__separator" role="separator" />,
            },
            {
              id: "command:retry-connect",
              label: t("connection.retryNow"),
              class: "sidebar-customize-menu__item sidebar-identity-menu__retry",
              content: <span class="sidebar-customize-menu__text">{t("connection.retryNow")}</span>,
            },
          ]
        : []),
      {
        kind: "content",
        id: "footer-separator",
        content: <div class="sidebar-customize-menu__separator" role="separator" />,
      },
      {
        kind: "group",
        id: "footer",
        class: "sidebar-identity-menu__footer",
        items: [
          {
            id: "command:about",
            label: t("aboutPage.artifactDetails"),
            render: (menuAttributes) => (
              <SidebarBuildChip
                variant="identity"
                basePath={params.basePath}
                gatewayVersion={params.gatewayVersion}
                menuAttributes={menuAttributes}
                copyButtonRef={controls.ref()}
              />
            ),
          },
          {
            id: "command:theme",
            label: t("common.colorMode"),
            closeOnSelect: false,
            render: (menuAttributes) => (
              <span class="sidebar-mode-switch">
                <ThemeModeToggle
                  mode={params.themeMode}
                  menuAttributes={menuAttributes}
                  onChange={params.onThemeChange}
                />
              </span>
            ),
          },
        ],
      },
    ];
  });
  return (
    <SidebarDropdown
      controls={controls}
      class="sidebar-customize-menu sidebar-identity-menu"
      position={params.position}
      anchor={params.anchor}
      tabFocusTarget={params.tabFocusTarget}
      label={t("profilePage.identity.menuLabel")}
      panelStyle={{ "--sidebar-identity-menu-min-width": `${params.triggerWidth}px` }}
      items={items()}
      onClose={params.onClose}
      onSelect={(value) => {
        if (value === "command:theme") {
          return;
        }
        params.onClose(false);
        if (selectSidebarHelpLink(value)) {
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
          case `${COMMAND_VALUE_PREFIX}about`:
            params.onNavigate("about");
            break;
          case `${COMMAND_VALUE_PREFIX}profile`:
            params.onNavigate("profile", { hash: "#settings-profile-identity" });
            break;
          case `${COMMAND_VALUE_PREFIX}settings`:
            params.onNavigate("appearance");
            break;
          case `${COMMAND_VALUE_PREFIX}updates`:
            params.onNavigate("updates");
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
    />
  );
}

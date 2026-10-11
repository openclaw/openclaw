import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import type { JSX } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  isPluginsHubRoute,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  serializeSidebarEntry,
  type NavigationRouteId,
  SIDEBAR_NAV_ROUTES,
  type SidebarNavRoute,
  sidebarMoreRoutes,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { iconData, type IconName } from "./icon-data.ts";
import { Icon } from "./solid/icon.tsx";
import { renderMenuTrigger } from "./solid/menu-trigger.tsx";
import { consumeDropdownKeyboardDismissal, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type SidebarMenuPosition = { x: number; y: number };

export function renderSidebarMenuAction(
  value: string,
  label: string,
  icon: IconName,
  options: { disabled?: boolean; title?: string; className?: string; details?: JSX.Element } = {},
): JSX.Element {
  return (
    <wa-dropdown-item
      class={["sidebar-customize-menu__item", options.className]}
      value={value}
      disabled={options.disabled}
      title={options.title ?? undefined}
    >
      <span slot="icon" class="nav-item__icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span class="sidebar-customize-menu__text">{label}</span>
      {options.details ?? undefined}
    </wa-dropdown-item>
  );
}

export function SidebarDropdown(params: {
  position: SidebarMenuPosition;
  class: string;
  label: string;
  onSelect: (item: Element) => void;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
  content: JSX.Element;
}): JSX.Element {
  return (
    <wa-dropdown
      class={params.class}
      prop:open={true}
      placement="bottom-start"
      prop:distance={0}
      aria-label={params.label}
      onWa-select={(event: WaSelectEvent) => {
        event.preventDefault();
        params.onSelect(event.detail.item);
      }}
      onKeyDown={(event: KeyboardEvent) => trackDropdownKeyboardDismissal(event, params.onTabAway)}
      onWa-after-hide={(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
    >
      {renderMenuTrigger(params.position, params.label)} {params.content}
    </wa-dropdown>
  );
}

/** Settings routes highlight Settings; hub tabs highlight their hub entry. */
export function isSidebarRouteActive(
  activeRouteId: NavigationRouteId | undefined,
  routeId: NavigationRouteId,
): boolean {
  if (activeRouteId === undefined) {
    return false;
  }
  if (routeId === "config") {
    return isSettingsNavigationRoute(activeRouteId);
  }
  if (routeId === "plugins") {
    return isPluginsHubRoute(activeRouteId);
  }
  if (routeId === "sessions") {
    return isSessionsHubRoute(activeRouteId);
  }
  return activeRouteId === routeId;
}

export function sidebarPluginTabs(
  tabs: readonly GatewayControlUiPluginTab[] | undefined,
): GatewayControlUiPluginTab[] {
  const known = tabs ?? [];
  return ["chat", "control", "agent", "settings"].flatMap((group) =>
    known.filter((tab) => (tab.group ?? "control") === group),
  );
}

export function renderSidebarNavLink(params: {
  href: string;
  active: boolean;
  icon: JSX.Element;
  label: string;
  onNavigate: () => void;
  onPreload?: (event: Event, immediate?: boolean) => void;
  onCancelPreload?: (event: Event) => void;
}): JSX.Element {
  const onPreload = params.onPreload;
  return (
    <a
      href={params.href}
      class={["nav-item", { "nav-item--active": params.active }]}
      aria-current={params.active ? "page" : undefined}
      onFocus={onPreload ? (event: Event) => onPreload(event) : undefined}
      onBlur={params.onCancelPreload ?? undefined}
      onPointerEnter={onPreload ? (event: Event) => onPreload(event) : undefined}
      onPointerLeave={params.onCancelPreload ?? undefined}
      onTouchStart={onPreload ? (event: TouchEvent) => onPreload(event, true) : undefined}
      onClick={(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        params.onNavigate();
      }}
    >
      <span class="nav-item__icon" aria-hidden="true">
        {params.icon}
      </span>
      <span class="nav-item__text">{params.label}</span>
    </a>
  );
}

type SidebarMenuNavigationHandlers = {
  onNavigateRoute: (routeId: SidebarNavRoute) => void;
  onPreloadRoute: (routeId: SidebarNavRoute, event: Event) => void;
  onCancelPreload: (event: Event) => void;
};

type SidebarMoreMenuParams = SidebarMenuNavigationHandlers & {
  position: SidebarMenuPosition;
  basePath: string;
  activeRouteId: NavigationRouteId | undefined;
  sidebarEntries: readonly string[];
  isRouteEnabled: (routeId: NavigationRouteId) => boolean;
  onEditPinnedItems: () => void;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
};

function renderMoreMenuRoute(params: SidebarMoreMenuParams, routeId: SidebarNavRoute): JSX.Element {
  const active = createMemo(() => isSidebarRouteActive(params.activeRouteId, routeId));
  return (
    <wa-dropdown-item
      value={routeId}
      class={["sidebar-customize-menu__item", { "sidebar-customize-menu__item--active": active() }]}
      aria-current={active() ? "page" : undefined}
      onPointerEnter={(event: Event) => params.onPreloadRoute(routeId, event)}
      onPointerLeave={params.onCancelPreload}
      ref={(item) => {
        // Web Awesome selects synchronously, before Solid's delegated click handler.
        item.addEventListener("click", (event) => {
          if (!shouldHandleNavigationClick(event)) {
            item.setAttribute("data-native-navigation", "");
            return;
          }
          event.preventDefault();
        });
      }}
    >
      <a href={pathForRoute(routeId, params.basePath)} tabindex="-1">
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name={navigationIconForRoute(routeId)} />
        </span>
        <span class="sidebar-customize-menu__text">{titleForRoute(routeId)}</span>
      </a>
    </wa-dropdown-item>
  );
}

export function renderSidebarMoreMenu(params: SidebarMoreMenuParams): JSX.Element {
  const moreRoutes = createMemo(() =>
    sidebarMoreRoutes(params.sidebarEntries).filter((routeId) => params.isRouteEnabled(routeId)),
  );
  return (
    <SidebarDropdown
      {...params}
      class="sidebar-customize-menu sidebar-more-menu"
      label={t("nav.more")}
      onSelect={(item) => {
        if (item.hasAttribute("data-native-navigation")) {
          item.removeAttribute("data-native-navigation");
          return;
        }
        const value = item.getAttribute("value") ?? undefined;
        if (value === "customize") {
          params.onEditPinnedItems();
          return;
        }
        const route = moreRoutes().find((routeId) => routeId === value);
        if (route) {
          params.onNavigateRoute(route);
        }
      }}
      content={
        <>
          <For each={moreRoutes()}>{(routeId) => renderMoreMenuRoute(params, routeId)}</For>
          <div class="sidebar-customize-menu__separator" role="separator" />
          {renderSidebarMenuAction("customize", t("nav.customize"), "penLine")}
        </>
      }
    />
  );
}

type SidebarCustomizeMenuParams = {
  position: SidebarMenuPosition;
  sidebarEntries: readonly string[];
  preferencesBrowserOnly: boolean;
  isRouteEnabled: (routeId: NavigationRouteId) => boolean;
  pluginNavigation: ControlUiRegistration<ControlUiNavigationItem>[];
  onToggleRoute: (routeId: SidebarNavRoute) => void;
  onTogglePlugin: (key: string) => void;
  onReset: () => void;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
};

export function renderSidebarCustomizeMenu(params: SidebarCustomizeMenuParams): JSX.Element {
  const choices = createMemo(() => [
    ...SIDEBAR_NAV_ROUTES.filter((routeId) => params.isRouteEnabled(routeId)).map((routeId) => ({
      value: routeId,
      entry: serializeSidebarEntry({ type: "route", route: routeId }),
      icon: navigationIconForRoute(routeId),
      label: titleForRoute(routeId),
    })),
    ...params.pluginNavigation.map((entry) => ({
      value: `plugin:${entry.key}`,
      entry: `plugin:${entry.key}`,
      icon:
        entry.value.icon && Object.hasOwn(iconData, entry.value.icon)
          ? (entry.value.icon as IconName) // SAFETY: The preceding own-key guard admits only keys of iconData.
          : ("plug" as const),
      label: entry.value.label,
    })),
  ]);
  return (
    <SidebarDropdown
      {...params}
      class="sidebar-customize-menu sidebar-pin-editor-menu"
      label={t("nav.customize")}
      onSelect={(item) => {
        const value = item.getAttribute("value") ?? undefined;
        if (value === "reset") {
          params.onReset();
        } else if (value?.startsWith("plugin:")) {
          const key = value.slice("plugin:".length);
          if (params.pluginNavigation.some((entry) => entry.key === key)) {
            params.onTogglePlugin(key);
          }
        } else {
          const route = SIDEBAR_NAV_ROUTES.find((routeId) => routeId === value);
          if (route) {
            params.onToggleRoute(route);
          }
        }
      }}
      content={
        <>
          <div class="sidebar-customize-menu__title">{t("nav.customize")}</div>
          {params.preferencesBrowserOnly ? (
            <div class="sidebar-customize-menu__provenance" role="note">
              {t("quickSettings.personal.browserOnly")}
            </div>
          ) : undefined}
          <For each={choices()} keyed={(choice) => choice.value}>
            {(choice) => (
              <wa-dropdown-item
                class="sidebar-customize-menu__item"
                type="checkbox"
                value={choice().value}
                prop:checked={params.sidebarEntries.includes(choice().entry)}
              >
                <span slot="icon" class="nav-item__icon" aria-hidden="true">
                  {<Icon name={choice().icon} />}
                </span>
                <span class="sidebar-customize-menu__text">{choice().label}</span>
              </wa-dropdown-item>
            )}
          </For>
          <div class="sidebar-customize-menu__separator" role="separator" />
          {renderSidebarMenuAction("reset", t("nav.customizeReset"), "refresh")}
        </>
      }
    />
  );
}

export function renderSidebarPluginNavigationMenu(params: {
  position: SidebarMenuPosition;
  item: ControlUiNavigationItem;
  onSelect: (id: string) => Promise<void>;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
}): JSX.Element {
  return (
    <SidebarDropdown
      {...params}
      class="sidebar-customize-menu sidebar-plugin-navigation-menu"
      label={params.item.label}
      onSelect={(item) => {
        const value = item.getAttribute("value");
        if (value) {
          void params.onSelect(value);
        }
      }}
      content={
        <For each={params.item.actions ?? []}>
          {(action) => {
            const icon =
              action.icon && Object.hasOwn(iconData, action.icon) ? (
                // SAFETY: The preceding own-key guard admits only keys of iconData.
                <Icon name={action.icon as IconName} />
              ) : undefined;
            return (
              <wa-dropdown-item
                class={[
                  "sidebar-customize-menu__item",
                  { "session-menu__item--destructive": action.destructive },
                ]}
                value={action.id}
                variant={action.destructive ? "danger" : "default"}
              >
                <span slot="icon" class="nav-item__icon" aria-hidden="true">
                  {icon}
                </span>
                <span class="sidebar-customize-menu__text">{action.label}</span>
              </wa-dropdown-item>
            );
          }}
        </For>
      }
    />
  );
}

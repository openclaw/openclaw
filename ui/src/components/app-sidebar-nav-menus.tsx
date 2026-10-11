import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  isPluginsHubRoute,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
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
      draggable="false"
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

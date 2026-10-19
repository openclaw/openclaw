import type { JSX } from "@solidjs/web";
import { createUniqueId, onCleanup } from "solid-js";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  isPluginsHubRoute,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import { iconData, type IconName } from "./icon-data.ts";
import { Icon } from "./solid/icon.tsx";
import { pointMenuTriggerAttributes } from "./solid/menu-trigger.tsx";
import { Menu, type MenuEntry, type MenuHandle, type MenuItem } from "./solid/menu.tsx";

type SidebarMenuPosition = { x: number; y?: number; top?: number; bottom?: number };

export function renderSidebarMenuAction(
  value: string,
  label: string,
  icon: IconName,
  options: { disabled?: boolean; title?: string; className?: string; details?: JSX.Element } = {},
): MenuItem {
  return {
    id: value,
    label,
    class: ["sidebar-customize-menu__item", options.className],
    disabled: options.disabled,
    attributes: { title: options.title },
    icon: (
      <span class="nav-item__icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
    ),
    content: <span class="sidebar-customize-menu__text">{label}</span>,
    details: options.details,
  };
}

export type SidebarDropdownProps = {
  position: SidebarMenuPosition;
  class: JSX.ClassValue;
  label: string;
  anchor?: HTMLElement;
  items: readonly MenuEntry[];
  onSelect: (id: string) => void;
  tabFocusTarget?: (backward: boolean) => HTMLElement | undefined;
  onClose: (restoreFocus: boolean) => void;
  onAfterShow?: (event: Event) => void;
  onOpenChange?: (open: boolean) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  panelStyle?: JSX.CSSProperties;
  focusOnOpen?: boolean;
  ref?: (handle: MenuHandle) => void;
};

export function SidebarDropdown(params: SidebarDropdownProps): JSX.Element {
  const id = createUniqueId();
  let removeListeners: (() => void)[] = [];
  onCleanup(() => removeListeners.forEach((stop) => stop()));
  return (
    <Menu
      id={`sidebar-menu-${id}`}
      panelClass={params.class}
      label={params.label}
      open
      items={params.items}
      placement={params.position.bottom === undefined ? "bottom-start" : "top-start"}
      triggerAttributes={pointMenuTriggerAttributes(
        {
          x: params.position.x,
          y: params.position.bottom ?? params.position.top ?? params.position.y,
        },
        params.position.bottom === undefined ? "top" : "bottom",
      )}
      ref={(handle) => {
        params.ref?.(handle);
        const { overlay } = handle;
        overlay.surface.dataset.chatAutotypeExempt = "";
        if (params.anchor) {
          overlay.setReturnTarget(params.anchor);
        }
        if (params.panelStyle) {
          for (const [property, value] of Object.entries(params.panelStyle)) {
            overlay.surface.style.setProperty(property, String(value));
          }
        }
        removeListeners = [
          listen(overlay.surface, "pointerenter", () => params.onPointerEnter?.()),
          listen(overlay.surface, "pointerleave", () => params.onPointerLeave?.()),
        ];
        overlay.request(true, params.focusOnOpen === false ? "none" : "first");
      }}
      tabFocusTarget={params.tabFocusTarget}
      onSelect={(item) => params.onSelect(item.id)}
      onAfterShow={params.onAfterShow}
      onOpenChange={(open) => {
        params.onOpenChange?.(open);
        if (!open) {
          params.onClose(false);
        }
      }}
    />
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
  ref?: (element: HTMLAnchorElement) => void;
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
      ref={(element) => params.ref?.(element)}
      draggable="false"
      href={params.href}
      class={["nav-item", { "nav-item--active": params.active }]}
      aria-current={params.active ? "page" : undefined}
      onFocus={onPreload ? (event: Event) => onPreload(event) : undefined}
      onBlur={params.onCancelPreload}
      onPointerEnter={onPreload ? (event: Event) => onPreload(event) : undefined}
      onPointerLeave={params.onCancelPreload}
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
  anchor?: HTMLElement;
  onSelect: (id: string) => Promise<void>;
  tabFocusTarget?: (backward: boolean) => HTMLElement | undefined;
  onClose: (restoreFocus: boolean) => void;
}): JSX.Element {
  return (
    <SidebarDropdown
      {...params}
      class="sidebar-customize-menu sidebar-plugin-navigation-menu"
      label={params.item.label}
      onSelect={(id) => void params.onSelect(id)}
      items={(params.item.actions ?? []).map((action): MenuItem => ({
        id: action.id,
        label: action.label,
        class: [
          "sidebar-customize-menu__item",
          { "session-menu__item--destructive": action.destructive },
        ],
        variant: action.destructive ? "danger" : undefined,
        icon:
          action.icon && Object.hasOwn(iconData, action.icon) ? (
            <span class="nav-item__icon" aria-hidden="true">
              <Icon
                name={
                  // SAFETY: The preceding own-key guard admits only keys of iconData.
                  action.icon as IconName
                }
              />
            </span>
          ) : undefined,
        content: <span class="sidebar-customize-menu__text">{action.label}</span>,
      }))}
    />
  );
}

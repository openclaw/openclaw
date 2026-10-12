import { html, nothing, type TemplateResult } from "lit";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  isPluginsHubRoute,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { icons, type IconName } from "./icons.ts";
import { renderMenuTrigger } from "./menu-surface.ts";
import { consumeDropdownKeyboardDismissal, trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type SidebarMenuPosition = { x: number; y: number };

export function renderSidebarMenuAction(
  value: string,
  label: string,
  icon: IconName,
  options: { disabled?: boolean; title?: string; className?: string; details?: unknown } = {},
) {
  return html`<wa-dropdown-item
    class=${`sidebar-customize-menu__item${options.className ? ` ${options.className}` : ""}`}
    value=${value}
    ?disabled=${options.disabled}
    title=${options.title ?? nothing}
  >
    <span slot="icon" class="nav-item__icon" aria-hidden="true">${icons[icon]}</span>
    <span class="sidebar-customize-menu__text">${label}</span>
    ${options.details ?? nothing}
  </wa-dropdown-item>`;
}

export function renderSidebarDropdown(params: {
  position: SidebarMenuPosition;
  className: string;
  label: string;
  onSelect: (item: HTMLElement & { value: string }) => void;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
  content: unknown;
}) {
  return html`<wa-dropdown
    class=${params.className}
    .open=${true}
    placement="bottom-start"
    .distance=${0}
    aria-label=${params.label}
    @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value: string } }>) => {
      event.preventDefault();
      params.onSelect(event.detail.item);
    }}
    @keydown=${(event: KeyboardEvent) => trackDropdownKeyboardDismissal(event, params.onTabAway)}
    @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
  >
    ${renderMenuTrigger(params.position, params.label)} ${params.content}
  </wa-dropdown>`;
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
  icon: TemplateResult;
  label: string;
  onNavigate: () => void;
  onPreload?: (event: Event, immediate?: boolean) => void;
  onCancelPreload?: (event: Event) => void;
}) {
  const onPreload = params.onPreload;
  return html`
    <a
      draggable="false"
      href=${params.href}
      class="nav-item ${params.active ? "nav-item--active" : ""}"
      aria-current=${params.active ? "page" : nothing}
      @focus=${onPreload ? (event: Event) => onPreload(event) : nothing}
      @blur=${params.onCancelPreload ?? nothing}
      @pointerenter=${onPreload ? (event: Event) => onPreload(event) : nothing}
      @pointerleave=${params.onCancelPreload ?? nothing}
      @touchstart=${
        onPreload
          ? {
              handleEvent: (event: TouchEvent) => onPreload(event, true),
              passive: true,
            }
          : nothing
      }
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        params.onNavigate();
      }}
    >
      <span class="nav-item__icon" aria-hidden="true">${params.icon}</span>
      <span class="nav-item__text">${params.label}</span>
    </a>
  `;
}

export function renderSidebarPluginNavigationMenu(params: {
  position: SidebarMenuPosition;
  item: ControlUiNavigationItem;
  onSelect: (id: string) => Promise<void>;
  onTabAway: () => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  return renderSidebarDropdown({
    ...params,
    className: "sidebar-customize-menu sidebar-plugin-navigation-menu",
    label: params.item.label,
    onSelect: ({ value }) => void params.onSelect(value),
    content: html`
      ${(params.item.actions ?? []).map((action) => {
        const icon =
          action.icon && Object.hasOwn(icons, action.icon)
            ? icons[action.icon as IconName] // SAFETY: only own keys of the shared icon registry are admitted.
            : nothing;
        return html`<wa-dropdown-item
          class="sidebar-customize-menu__item ${action.destructive ? "session-menu__item--destructive" : ""}"
          value=${action.id}
          variant=${action.destructive ? "danger" : "neutral"}
        >
          <span slot="icon" class="nav-item__icon" aria-hidden="true">${icon}</span>
          <span class="sidebar-customize-menu__text">${action.label}</span>
        </wa-dropdown-item>`;
      })}
    `,
  });
}

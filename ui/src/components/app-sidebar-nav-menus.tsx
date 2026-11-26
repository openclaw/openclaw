import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  isPluginsHubRoute,
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";

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
  const known = (tabs ?? []).filter((tab) => tab.placement !== "settings");
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
  indicator?: string;
  onNavigate: () => void;
}): JSX.Element {
  return (
    <a
      ref={(element) => params.ref?.(element)}
      draggable="false"
      href={params.href}
      class={["nav-item", { "nav-item--active": params.active }]}
      aria-current={params.active ? "page" : undefined}
      aria-description={params.indicator}
      onClick={(event: MouseEvent) => handleNavigationClick(event, () => params.onNavigate())}
    >
      <span class="nav-item__icon" aria-hidden="true">
        {params.icon}
      </span>
      <span class="nav-item__text">{params.label}</span>
      <Show when={params.indicator}>
        <span
          class="sidebar-automations__failed"
          style="position:absolute;inset-block-start:5px;inset-inline-end:5px;margin:0"
          aria-hidden="true"
        />
      </Show>
    </a>
  );
}

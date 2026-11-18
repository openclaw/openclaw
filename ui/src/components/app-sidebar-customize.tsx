import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderSidebarNavLink as SidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { IconName } from "./icon-data.ts";
import { Icon } from "./solid/icon.tsx";

const CUSTOMIZE_PAGES: ReadonlyArray<readonly [NavigationRouteId, IconName, string]> = [
  ["plugins", "plug", "tabs.plugins"],
  ["skills", "sparkles", "tabs.skills"],
  ["skill-workshop", "wandSparkles", "tabs.skillWorkshop"],
  ["templates", "blobster", "tabs.templates"],
];

/** The Customize section: its pages. */
export function SidebarCustomize(props: { host: AppSidebarRenderHost }): JSX.Element {
  // Enabled routes leave out Templates unless its experimental flag is on.
  const pages = () =>
    CUSTOMIZE_PAGES.filter(([route]) => props.host.enabledRouteIds?.includes(route) ?? true);
  const route = () => props.host.activeRouteId;
  return (
    <nav class="sidebar-customize" aria-label={titleForRoute("plugins", t)}>
      <For each={pages()}>
        {(page) => {
          const [pageRoute, icon, label] = page;
          const active = () => route() === pageRoute;
          return (
            <SidebarNavLink
              href={pathForRoute(pageRoute, props.host.basePath)}
              active={active()}
              icon={<Icon name={icon} filled={active()} />}
              label={t(label)}
              onNavigate={() => props.host.onNavigate?.(pageRoute)}
            />
          );
        }}
      </For>
    </nav>
  );
}

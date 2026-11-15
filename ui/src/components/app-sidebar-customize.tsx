import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { pathForPluginSettings, pathForRoute } from "../app-route-paths.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { loadPluginCatalog } from "../lib/plugins/index.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
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

/** The Customize section: the hub's pages, then one row per installed plugin. */
export function SidebarCustomize(props: { host: AppSidebarRenderHost }): JSX.Element {
  const app = useApplication();
  const gateway = projectGateway(app.gateway);
  const [revision, setRevision] = createSignal(0);
  onSettled(() =>
    app.gateway.subscribeEvents((event) => {
      if (event.event === "plugins.changed") {
        setRevision((value) => value + 1);
      }
    }),
  );
  const installed = createMemo(async () => {
    revision();
    gateway.revision();
    const snapshot = app.gateway.snapshot;
    if (!snapshot.client || !canCallGatewayMethod(snapshot, "plugins.list", "operator.read")) {
      return [];
    }
    const result = await loadPluginCatalog(snapshot.client).catch(() => null);
    return (result?.plugins ?? [])
      .filter((plugin) => plugin.installed)
      .toSorted((left, right) => left.name.localeCompare(right.name));
  });
  // Enabled routes leave out Templates unless its experimental flag is on.
  const pages = () =>
    CUSTOMIZE_PAGES.filter(([route]) => props.host.enabledRouteIds?.includes(route) ?? true);
  return (
    <nav class="sidebar-customize" aria-label={titleForRoute("plugins", t)}>
      <For each={pages()}>
        {(page) => {
          const [route, icon, label] = page;
          const active = () => props.host.activeRouteId === route;
          return (
            <SidebarNavLink
              href={pathForRoute(route, props.host.basePath)}
              active={active()}
              icon={<Icon name={icon} filled={active()} />}
              label={t(label)}
              onNavigate={() => props.host.onNavigate?.(route)}
            />
          );
        }}
      </For>
      <Show when={installed().length > 0}>
        <div class="sidebar-customize__group" role="group" aria-label={t("pluginsPage.installed")}>
          <span class="sidebar-customize__heading">{t("pluginsPage.installed")}</span>
          <For each={installed()}>
            {(plugin) => (
              // An installed plugin's page is its settings page; "from" returns it to Plugins.
              <SidebarNavLink
                href={`${pathForPluginSettings(plugin.id, props.host.basePath)}?from=plugins`}
                active={false}
                icon={<Icon name="plug" />}
                label={plugin.name}
                onNavigate={() =>
                  props.host.onNavigate?.("plugin-settings", {
                    pathname: pathForPluginSettings(plugin.id, props.host.basePath),
                    search: "?from=plugins",
                  })
                }
              />
            )}
          </For>
        </div>
      </Show>
    </nav>
  );
}

import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { pathForPluginSettings, pathForRoute } from "../app-route-paths.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { loadPluginCatalog } from "../lib/plugins/index.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../pages/plugins/plugin-icon-owner.ts";
import { pluginFallbackGradient, pluginMonogram } from "../pages/plugins/presentation.ts";
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

/** A plugin's icon, or the Plugins page's gradient monogram while it has none. */
function PluginIcon(props: { id: string; name: string; url?: string }) {
  const gradient = () => pluginFallbackGradient(props.id);
  return (
    <Show
      when={props.url}
      fallback={
        <span
          class="sidebar-customize__plugin-icon sidebar-customize__plugin-icon--fallback"
          style={{ "--plugins-art-a": gradient()[0], "--plugins-art-b": gradient()[1] }}
          aria-hidden="true"
        >
          {pluginMonogram(props.name).slice(0, 1)}
        </span>
      }
    >
      {(url) => <img class="sidebar-customize__plugin-icon" src={url()} alt="" />}
    </Show>
  );
}

/** Every installed plugin, each opening its settings page, whichever Customize page is open. */
function CustomizePlugins(props: { host: AppSidebarRenderHost }) {
  const app = useApplication();
  const gateway = projectGateway(app.gateway);
  const [revision, setRevision] = createSignal(0);
  const [iconUrls, setIconUrls] = createSignal<Record<string, string>>({});
  let mounted = true;
  const icons = new PluginIconOwner({
    getFetchContext: () => pluginIconFetchContext(app),
    isConnected: () => mounted,
    onUrlsChange: setIconUrls,
  });
  onSettled(() => () => {
    mounted = false;
    icons.reset();
  });
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
    const plugins = (result?.plugins ?? [])
      .filter((plugin) => plugin.installed)
      .toSorted((left, right) => left.name.localeCompare(right.name));
    // Each listed plugin shows its own icon, read the way the Plugins page reads it.
    const withIcons = plugins.filter((plugin) => plugin.hasIcon).map((plugin) => plugin.id);
    icons.reconcileKeys(new Set(withIcons));
    for (const id of withIcons) {
      icons.load(id);
    }
    return plugins;
  });
  return (
    <Show when={installed().length > 0}>
      <div class="sidebar-customize__group" role="group" aria-label={t("pluginsPage.installed")}>
        <span class="sidebar-customize__heading">{t("pluginsPage.installed")}</span>
        <For each={installed()}>
          {(plugin) => (
            // An installed plugin's page is its settings page; "from" returns it to Plugins.
            <SidebarNavLink
              href={`${pathForPluginSettings(plugin.id, props.host.basePath)}?from=plugins`}
              active={false}
              icon={<PluginIcon id={plugin.id} name={plugin.name} url={iconUrls()[plugin.id]} />}
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
  );
}

/** The Customize section: its pages, then every installed plugin. */
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
      <CustomizePlugins host={props.host} />
    </nav>
  );
}

import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
import type {
  PluginCatalogEntry,
  PluginsListResult,
} from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { pathForPluginCatalogEntry, pathForRoute } from "../app-route-paths.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { PluginArtTile } from "../pages/plugins/consent-dialog.tsx";
import { PluginIconOwner, pluginIconFetchContext } from "../pages/plugins/plugin-icon-owner.ts";
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

// The sidebar is a shortcut list, not an inventory; the Plugins page lists everything.
const MAX_SIDEBAR_PLUGINS = 8;

type SidebarPlugin = PluginCatalogEntry & { catalogId: string };

/** Plugins people added, newest install first, then the bundled ones that opted in. */
function sidebarPlugins(plugins: readonly PluginCatalogEntry[]): SidebarPlugin[] {
  return plugins
    .filter(
      (plugin): plugin is SidebarPlugin =>
        plugin.installed &&
        Boolean(plugin.catalogId) &&
        (plugin.origin !== "bundled" || (plugin.enabled && plugin.sidebar === true)),
    )
    .toSorted(
      (left, right) =>
        (right.installedAt ?? -1) - (left.installedAt ?? -1) || left.name.localeCompare(right.name),
    )
    .slice(0, MAX_SIDEBAR_PLUGINS);
}

function SidebarPages(props: { host: AppSidebarRenderHost; pluginSelected: boolean }) {
  // Enabled routes leave out Templates unless its experimental flag is on.
  const pages = () =>
    CUSTOMIZE_PAGES.filter(([route]) => props.host.enabledRouteIds?.includes(route) ?? true);
  return (
    <For each={pages()}>
      {(page) => {
        const [pageRoute, icon, label] = page;
        // A listed plugin's detail selects its own row instead of the catalog's.
        const active = () =>
          props.host.activeRouteId === pageRoute &&
          !(pageRoute === "plugins" && props.pluginSelected);
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
  );
}

function SidebarPlugins(props: {
  host: AppSidebarRenderHost;
  plugins: readonly SidebarPlugin[];
  pathname: string;
}) {
  const context = useApplication();
  const [iconUrls, setIconUrls] = createSignal<Record<string, string>>({}, { ownedWrite: true });
  // Misses are owner state; this revision lets a missing icon settle on its monogram.
  const [iconMisses, setIconMisses] = createSignal(0, { ownedWrite: true });
  let mounted = true;
  const icons = new PluginIconOwner({
    getFetchContext: () => pluginIconFetchContext(context),
    isConnected: () => mounted,
    onUrlsChange: setIconUrls,
    onUnavailable: () => setIconMisses((count) => count + 1),
  });
  const iconPending = (plugin: SidebarPlugin) => {
    iconMisses();
    return plugin.hasIcon === true && !icons.isUnavailable(plugin.id);
  };
  onSettled(() => () => {
    mounted = false;
    icons.reset();
  });
  return (
    <Show when={props.plugins.length > 0}>
      <div
        class="sidebar-customize__plugins"
        role="group"
        aria-labelledby="sidebar-customize-plugins"
      >
        <div class="sidebar-customize__heading">
          <span id="sidebar-customize-plugins" class="sidebar-recent-sessions__label-text">
            {t("nav.installedPlugins")}
          </span>
        </div>
        <For each={props.plugins} keyed={(plugin) => plugin.id}>
          {(plugin) => {
            const href = () => pathForPluginCatalogEntry(plugin().catalogId, props.host.basePath);
            return (
              <SidebarNavLink
                href={href()}
                active={props.pathname === href()}
                icon={
                  <PluginArtTile
                    registerIcon={(readId) => {
                      if (plugin().hasIcon) {
                        icons.load(readId());
                      }
                      return () => {};
                    }}
                    slug={plugin().id}
                    // One initial reads at row size; the detail page shows the full monogram.
                    name={Array.from(plugin().name.trim())[0] ?? ""}
                    iconUrl={iconUrls()[plugin().id]}
                    loading={iconPending(plugin())}
                    onIconError={() => {
                      icons.handleError(plugin().id);
                      setIconMisses((count) => count + 1);
                    }}
                    class="sidebar-customize__plugin-icon"
                  />
                }
                label={plugin().name}
                onNavigate={() => props.host.onNavigate?.("plugins", { pathname: href() })}
              />
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/** The Customize section: its pages, then shortcuts to the plugins people use. */
export function SidebarCustomize(props: { host: AppSidebarRenderHost }): JSX.Element {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const location = projectOwner(
    context.router,
    (router) => router.getState().location.pathname,
    Object.is,
  );
  const client = createMemo(() => gateway.read().snapshot.client);
  const epoch = createMemo(() => gateway.read().connectionRevision);
  // Installs, removals and enablement advance the plugin generation.
  const generation = createMemo(() => gateway.read().snapshot.pluginCapabilities?.generation);
  const allowed = createMemo(() =>
    canCallGatewayMethod(gateway.read().snapshot, "plugins.list", "operator.read"),
  );
  const inventory = createMemo(() => {
    epoch();
    generation();
    return allowed()
      ? client()
          ?.request<PluginsListResult>("plugins.list", {})
          .catch(() => null)
      : null;
  });
  const plugins = createMemo(() => sidebarPlugins(inventory()?.plugins ?? []));
  const pluginSelected = () =>
    plugins().some(
      (plugin) =>
        pathForPluginCatalogEntry(plugin.catalogId, props.host.basePath) === location.read(),
    );
  // Pages render at once; the inventory only adds rows below them when it lands.
  const PagesOnly = () => <SidebarPages host={props.host} pluginSelected={false} />;
  return (
    <nav class="sidebar-customize" aria-label={titleForRoute("plugins", t)}>
      <Errored fallback={() => <PagesOnly />}>
        <Loading on={[client(), epoch()]} fallback={<PagesOnly />}>
          <SidebarPages host={props.host} pluginSelected={pluginSelected()} />
          <SidebarPlugins host={props.host} plugins={plugins()} pathname={location.read()} />
        </Loading>
      </Errored>
    </nav>
  );
}

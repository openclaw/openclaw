import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_PLUGIN_SETTINGS_PATH_PARAM,
  INTERNAL_PLUGINS_PATH_PARAM,
  pathForRoute,
  pathForPluginCatalogEntry,
  pluginCatalogIdFromPath,
  restoreBridgedRouteLocation,
} from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";

export type PluginsInventoryRead = {
  readonly gateway: ApplicationContext["gateway"];
  readonly gatewaySnapshot: ApplicationGatewaySnapshot;
  readonly generation: number | undefined;
  readonly signal: AbortSignal;
  readonly result: Promise<{ value: PluginListResult } | { error: unknown }>;
};

export type PluginsRouteData = {
  location: RouteLocation;
  inventory?: PluginsInventoryRead;
};

export function pluginsRouteLocation(location: RouteLocation): RouteLocation {
  return restoreBridgedRouteLocation(
    restoreBridgedRouteLocation(location, INTERNAL_PLUGINS_PATH_PARAM),
    INTERNAL_PLUGIN_SETTINGS_PATH_PARAM,
  );
}

export function canonicalPluginsRouteLocation(
  location: RouteLocation,
  basePath = "",
): RouteLocation | null {
  const searchParams = new URLSearchParams(location.search);
  const settingsPath = pathForRoute("plugin-settings", basePath);
  const legacyTab = searchParams.get("tab");
  const supportedAdvancedTab = location.pathname === settingsPath && legacyTab === "advanced";
  const hadLegacyTab = legacyTab !== null && !supportedAdvancedTab;
  if (hadLegacyTab) {
    searchParams.delete("tab");
  }
  const isLegacyDiscoverPath = location.pathname === `${settingsPath}/discover`;
  const legacyDiscover = isLegacyDiscoverPath || legacyTab === "discover";
  const catalogId = pluginCatalogIdFromPath(location.pathname, basePath);
  const pathname = legacyDiscover
    ? pathForRoute("plugins", basePath)
    : catalogId
      ? pathForPluginCatalogEntry(catalogId, basePath)
      : location.pathname;
  if (!hadLegacyTab && pathname === location.pathname) {
    return null;
  }
  const search = searchParams.toString();
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
}

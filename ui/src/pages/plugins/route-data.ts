import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_PLUGIN_SETTINGS_PATH_PARAM,
  INTERNAL_PLUGINS_PATH_PARAM,
  pathForRoute,
  pathForPluginCatalogEntry,
  pluginCatalogIdFromPath,
  pluginSettingsIdFromPath,
  restoreBridgedRouteLocation,
} from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";

export type PluginsRouteData = {
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  result: PluginListResult | null;
  error: string | null;
  location: RouteLocation;
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
  const hadLegacyTab = searchParams.has("tab") && !supportedAdvancedTab;
  if (hadLegacyTab) {
    searchParams.delete("tab");
  }
  const search = searchParams.toString();
  const isLegacyDiscoverPath = location.pathname === `${settingsPath}/discover`;
  const legacyDiscover = isLegacyDiscoverPath || legacyTab === "discover";
  const catalogId = pluginCatalogIdFromPath(location.pathname, basePath);
  const pathname = legacyDiscover
    ? pathForRoute("plugins", basePath)
    : catalogId
      ? pathForPluginCatalogEntry(catalogId, basePath)
      : location.pathname;
  const canonical: RouteLocation = {
    pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
  return hadLegacyTab || pathname !== location.pathname ? canonical : null;
}

export function pluginIdForRoute(
  surface: "discovery" | "settings",
  pathname: string,
  basePath: string,
): string | null {
  return surface === "settings"
    ? pluginSettingsIdFromPath(pathname, basePath)
    : pluginCatalogIdFromPath(pathname, basePath);
}

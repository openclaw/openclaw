import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_PLUGIN_SETTINGS_PATH_PARAM,
  INTERNAL_PLUGINS_PATH_PARAM,
  pathForRoute,
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
  const canonical: RouteLocation = {
    pathname: legacyDiscover ? pathForRoute("plugins", basePath) : location.pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
  return hadLegacyTab || isLegacyDiscoverPath ? canonical : null;
}

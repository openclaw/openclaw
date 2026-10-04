import type { ControlUiPanelTarget } from "../../../src/plugin-sdk/control-ui.js";
import {
  pathForRoute,
  pluginTabSlugFromPath,
  INTERNAL_PLUGIN_PATH_PARAM,
} from "../app-route-paths.ts";
import { pluginPageParams, pluginTabRefFromSearch } from "../pages/plugin/target.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

/** Resolve only this host's plugin pages. The caller owns the originating chat pane. */
export function routeControlUiChatLink(
  plugins: ControlUiPluginCapability,
  basePath: string,
  href: string,
  open: (pluginId: string, target: ControlUiPanelTarget) => boolean,
): boolean {
  const url = URL.parse(href, window.location.href);
  if (
    !url ||
    url.origin !== window.location.origin ||
    url.hash ||
    url.searchParams.has(INTERNAL_PLUGIN_PATH_PARAM) ||
    (url.pathname !== pathForRoute("plugin", basePath) &&
      !pluginTabSlugFromPath(url.pathname, basePath))
  ) {
    return false;
  }
  const ref = pluginTabRefFromSearch(url.search, url.pathname, basePath);
  const page = plugins
    .registrations("pages")
    .find((entry) => entry.key === `${ref.pluginId}/${ref.id}`);
  const route = plugins
    .registrations("linkRoutes")
    .find(
      (entry) =>
        entry.pluginId === ref.pluginId &&
        entry.value.pageId === ref.id &&
        entry.value.from === "chat",
    );
  if (!page || page.signal.aborted || !route || route.signal.aborted || route.host !== page.host) {
    return false;
  }
  try {
    const target = route.value.resolve({ id: ref.id, params: pluginPageParams(url.search) });
    if (!target || route.signal.aborted || page.signal.aborted) {
      return false;
    }
    const panel = plugins
      .registrations("panels")
      .find(
        (entry) =>
          entry.pluginId === ref.pluginId &&
          entry.value.id === target.id &&
          entry.host === route.host &&
          !entry.signal.aborted,
      );
    return Boolean(panel && open(ref.pluginId, target));
  } catch (error) {
    plugins.reportError(ref.pluginId, error);
    return false;
  }
}

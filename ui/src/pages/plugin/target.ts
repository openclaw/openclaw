import { INTERNAL_PLUGIN_PATH_PARAM, pluginTabSlugFromPath } from "../../app-route-paths.ts";

export type PluginTabRef = {
  pluginId: string;
  id: string;
};

export function pluginTabRefFromSearch(search: string, pathname = "", basePath = ""): PluginTabRef {
  const params = new URLSearchParams(search);
  const tab = pluginTabSlugFromPath(params.get(INTERNAL_PLUGIN_PATH_PARAM) ?? pathname, basePath);
  return {
    pluginId: tab?.pluginId ?? params.get("plugin")?.trim() ?? "",
    id: tab?.id ?? params.get("id")?.trim() ?? "",
  };
}

/** Stable key for one tab; ids are only unique per plugin, so both parts matter. */
export function pluginTabKey(ref: PluginTabRef): string {
  return `${ref.pluginId}/${ref.id}`;
}

export function pluginPageParams(search: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...new URLSearchParams(search)]
      .filter(([key]) => key.startsWith("p."))
      .map(([key, value]) => [key.slice(2), value]),
  );
}

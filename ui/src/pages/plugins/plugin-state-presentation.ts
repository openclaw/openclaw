import type { PluginCatalogItem } from "../../lib/plugins/index.ts";

export function matchesPluginQuery(plugin: PluginCatalogItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (
    !needle ||
    [plugin.name, plugin.id, plugin.description, plugin.packageName].some((value) =>
      value?.toLocaleLowerCase().includes(needle),
    )
  );
}

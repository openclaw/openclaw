import { listBundledWebSearchPluginIds as listBundledWebSearchPluginIdsImpl } from "./bundled-web-search.js";

export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = listBundledWebSearchPluginIdsImpl();

export function listBundledWebSearchPluginIds(): string[] {
  return listBundledWebSearchPluginIdsImpl();
}

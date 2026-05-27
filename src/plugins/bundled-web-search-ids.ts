import { BUNDLED_WEB_SEARCH_PLUGIN_IDS as BUNDLED_WEB_SEARCH_PLUGIN_IDS_FROM_METADATA } from "./bundled-capability-metadata.js";

export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = BUNDLED_WEB_SEARCH_PLUGIN_IDS_FROM_METADATA;

export function listBundledWebSearchPluginIds(): string[] {
  return [...BUNDLED_WEB_SEARCH_PLUGIN_IDS];
}

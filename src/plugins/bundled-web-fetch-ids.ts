import { BUNDLED_WEB_FETCH_PLUGIN_IDS as BUNDLED_WEB_FETCH_PLUGIN_IDS_FROM_METADATA } from "./bundled-capability-metadata.js";

export const BUNDLED_WEB_FETCH_PLUGIN_IDS = BUNDLED_WEB_FETCH_PLUGIN_IDS_FROM_METADATA;

export function listBundledWebFetchPluginIds(): string[] {
  return [...BUNDLED_WEB_FETCH_PLUGIN_IDS];
}

/**
 * Public SDK subpath for browser plugin configuration, CDP URL, and auth helpers.
 */
export {
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  type ResolvedBrowserConfig,
  type ResolvedBrowserTabCleanupConfig,
} from "./browser-profiles.js";
export { parseBrowserHttpUrl, redactCdpUrl } from "./browser-cdp.js";
export { movePathToTrash } from "./browser-trash.js";
export type { BrowserControlAuth } from "./browser-control-auth.js";

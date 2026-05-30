import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function isDefaultBrowserPluginEnabledByConfig(cfg: OpenClawConfig): boolean {
  // The browser plugin owns plugin disablement; browser.enabled remains the
  // root switch for the bundled control surface.
  if (cfg.browser?.enabled === false) {
    return false;
  }
  return resolveEffectiveEnableState({
    id: "browser",
    origin: "bundled",
    config: normalizePluginsConfig(cfg.plugins),
    rootConfig: cfg,
    enabledByDefault: true,
  }).enabled;
}

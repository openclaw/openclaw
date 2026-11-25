import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRecord } from "../plugins/registry.js";
import { isOpenClawIdEnabled, isOpenClawIdPluginVisible } from "../shared/openclaw-id-policy.js";

export const CUSTOM_PLUGIN_UI_DISABLED_MESSAGE =
  "Custom plugin UI is disabled by Gateway configuration. An administrator can remove gateway.controlUi.experimental.customPlugins: false or set it to true.";

/** Keep the existing config-only opt-out without requiring a Labs opt-in. */
function isCustomPluginUiEnabled(config: OpenClawConfig | null): boolean {
  return config !== null && config.gateway?.controlUi?.experimental?.customPlugins !== false;
}

export function isControlUiPluginAllowed(plugin: Pick<PluginRecord, "id" | "origin">): boolean {
  // Bundled provenance comes from the loader, never the plugin manifest. Read
  // the applied snapshot so request-time admission does not reload config.
  const config = getRuntimeConfigSnapshot();
  return (
    isOpenClawIdPluginVisible(plugin.id, config) &&
    (plugin.origin === "bundled" || isCustomPluginUiEnabled(config))
  );
}

/** Compare the two applied browser-admission policies without reloading plugin code. */
export function controlUiPluginPolicyKey(config: OpenClawConfig): string {
  return `${isCustomPluginUiEnabled(config)}:${isOpenClawIdEnabled(config.gateway?.openclawId)}`;
}

import type { OpenClawConfig } from "../../config/types.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../../plugins/config-state.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";

const ACCESS_PLUGIN_ID = "openclaw-id-access";

/** Use the loader's policy precedence, including global disable and normalized ids. */
export function openClawIdAccessBlockReason(config: OpenClawConfig): string | undefined {
  if (!isOpenClawIdEnabled(config.gateway?.openclawId)) {
    return undefined;
  }
  const state = resolveEffectivePluginActivationState({
    id: ACCESS_PLUGIN_ID,
    origin: "bundled",
    config: normalizePluginsConfig(config.plugins),
    rootConfig: config,
    enabledByDefault: true,
  });
  return state.enabled ? undefined : state.reason;
}

export function openClawIdAccessWarning(config: OpenClawConfig): string | undefined {
  const reason = openClawIdAccessBlockReason(config);
  if (!reason) {
    return undefined;
  }
  const explanation =
    reason === "not in allowlist"
      ? "plugins.allow does not include openclaw-id-access. Run openclaw doctor to add it with your consent."
      : reason === "blocked by denylist"
        ? "plugins.deny includes openclaw-id-access. Remove that deny entry yourself if you want the page."
        : reason === "disabled in config"
          ? 'plugins.entries["openclaw-id-access"].enabled is false. Change that setting yourself if you want the page.'
          : reason === "plugins disabled"
            ? "plugins.enabled is false. Enable plugins yourself if you want the page."
            : `${reason}. Review your plugin policy if you want the page.`;
  return `OpenClaw ID is on, but the Access page stays off: ${explanation}`;
}

/** Explicit activation or consented Doctor repair admits only the bundled Access plugin. */
export function withOpenClawIdAccessAllowed(config: OpenClawConfig): OpenClawConfig {
  if (openClawIdAccessBlockReason(config) !== "not in allowlist") {
    return config;
  }
  return {
    ...config,
    plugins: { ...config.plugins, allow: [...(config.plugins?.allow ?? []), ACCESS_PLUGIN_ID] },
  };
}

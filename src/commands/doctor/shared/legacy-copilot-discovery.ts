import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "../../../config/legacy.default-agent-owner-state.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isRecord } from "./legacy-config-record-shared.js";

/** Drop the retired discovery switch before validation, including malformed values. */
export function removeLegacyCopilotDiscovery(config: OpenClawConfig): OpenClawConfig;
export function removeLegacyCopilotDiscovery(config: unknown): unknown;
export function removeLegacyCopilotDiscovery(config: unknown): unknown {
  if (!isRecord(config)) {
    return config;
  }
  const plugins = isRecord(config.plugins) ? config.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const entry = isRecord(entries?.["github-copilot"]) ? entries["github-copilot"] : undefined;
  const pluginConfig = isRecord(entry?.config) ? entry.config : undefined;
  const discovery = isRecord(pluginConfig?.discovery) ? pluginConfig.discovery : undefined;
  if (!discovery || (!Object.hasOwn(discovery, "enabled") && Object.keys(discovery).length > 0)) {
    return config;
  }
  const { enabled: _enabled, ...remainingDiscovery } = discovery;
  const nextConfig = { ...pluginConfig };
  if (Object.keys(remainingDiscovery).length === 0) {
    delete nextConfig.discovery;
  } else {
    nextConfig.discovery = remainingDiscovery;
  }
  const next = {
    ...config,
    plugins: {
      ...plugins,
      entries: { ...entries, "github-copilot": { ...entry, config: nextConfig } },
    },
  };
  setRetainedLegacyDefaultAgentId(next, getRetainedLegacyDefaultAgentId(config));
  return next;
}

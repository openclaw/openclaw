// Determines whether a channel is configured from bootstrap and plugin state.
import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "../channels/plugins/package-state-probes.js";
import {
  hasMeaningfulChannelConfigShallow,
  resolveChannelConfigRecord,
} from "./channel-configured-shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Resolves whether a channel has enough config, env, or plugin state to be considered setup. */
export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Treat explicit persisted config as configured before consulting channel-specific env/state
  // probes; user-authored config should win over inferred setup state.
  if (hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId))) {
    return true;
  }
  // Declared bootstrap metadata owns negative results too. Runtime credential
  // hooks must not turn saved auth or a different ambient env into activation intent.
  if (listBundledChannelIdsForPackageState("configuredState").includes(channelId.trim())) {
    return hasBundledChannelPackageState({ metadataKey: "configuredState", channelId, cfg, env });
  }
  // Bootstrap plugins cover channels that are available before full plugin registry loading.
  const plugin = getBootstrapChannelPlugin(channelId);
  return Boolean(plugin?.config?.hasConfiguredState?.({ cfg, env }));
}

import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "../channels/plugins/package-state-probes.js";
import {
  hasMeaningfulChannelConfigShallow,
  resolveChannelConfigRecord,
} from "./channel-config-activation.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Treat explicit persisted config as configured before consulting channel-specific env/state
  // probes; user-authored config should win over inferred setup state.
  if (hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId), channelId)) {
    return true;
  }
  // Declared bootstrap metadata owns negative results too. Runtime credential
  // hooks must not turn saved auth or a different ambient env into activation intent.
  if (listBundledChannelIdsForPackageState("configuredState").includes(channelId.trim())) {
    return hasBundledChannelPackageState({ metadataKey: "configuredState", channelId, cfg, env });
  }
  const plugin = getBootstrapChannelPlugin(channelId);
  return Boolean(plugin?.config?.hasConfiguredState?.({ cfg, env }));
}

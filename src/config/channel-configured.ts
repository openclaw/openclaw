import { hasMeaningfulChannelConfig } from "../channels/config-presence.js";
import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import { hasBundledChannelConfiguredState } from "../channels/plugins/configured-state.js";
import { hasBundledChannelPersistedAuthState } from "../channels/plugins/persisted-auth-state.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./config.js";

function resolveChannelConfig(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

function isGenericChannelConfigured(cfg: OpenClawConfig, channelId: string): boolean {
  const entry = resolveChannelConfig(cfg, channelId);
  return hasMeaningfulChannelConfig(entry);
}

export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (hasBundledChannelConfiguredState({ channelId, cfg, env })) {
    return true;
  }
  const pluginPersistedAuthState = hasBundledChannelPersistedAuthState({ channelId, cfg, env });
  if (pluginPersistedAuthState) {
    return true;
  }
  if (isGenericChannelConfigured(cfg, channelId)) {
    return true;
  }
  const plugin = getBootstrapChannelPlugin(channelId);
  return Boolean(plugin?.config?.hasConfiguredState?.({ cfg, env }));
}

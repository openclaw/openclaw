import { hasMeaningfulChannelConfig } from "../channels/config-presence.js";
import { getBundledChannelContractSurfaceModule } from "../channels/plugins/contract-surfaces.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./config.js";

type ChannelConfiguredSurface = {
  hasConfiguredState?: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  hasPersistedAuthState?: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
};

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

function getChannelConfiguredSurface(channelId: string): ChannelConfiguredSurface | null {
  return getBundledChannelContractSurfaceModule<ChannelConfiguredSurface>({
    pluginId: channelId,
    preferredBasename: "contract-surfaces.ts",
  });
}

export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const surface = getChannelConfiguredSurface(channelId);
  const pluginConfigured = surface?.hasConfiguredState?.({ cfg, env });
  if (pluginConfigured) {
    return true;
  }
  const pluginPersistedAuthState = surface?.hasPersistedAuthState?.({ cfg, env });
  if (pluginPersistedAuthState) {
    return true;
  }
  return isGenericChannelConfigured(cfg, channelId);
}

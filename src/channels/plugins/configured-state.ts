import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

/** Lists bundled channels with declarative configured-state metadata. */
export function listBundledChannelIdsWithConfiguredState(
  discovery?: PluginDiscoveryResult,
): string[] {
  return listBundledChannelIdsForPackageState("configuredState", discovery);
}

/** Checks whether a bundled channel appears configured without loading full plugin source. */
export function hasBundledChannelConfiguredState(params: {
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  discovery?: PluginDiscoveryResult;
}): boolean {
  return hasBundledChannelPackageState({
    metadataKey: "configuredState",
    channelId: params.channelId,
    cfg: params.cfg,
    env: params.env,
    discovery: params.discovery,
  });
}

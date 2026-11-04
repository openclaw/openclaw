// Loaded-target resolution uses only already-loaded plugins so hot send paths
// can avoid triggering channel discovery.
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import {
  resolveOutboundTargetWithPlugin,
  type OutboundTargetResolution,
  type ResolveOutboundTargetParams,
} from "./targets-resolve-shared.js";

/** Resolves targets through an already-loaded channel plugin without bootstrap discovery. */
export async function tryResolveLoadedOutboundTarget(
  params: ResolveOutboundTargetParams,
): Promise<OutboundTargetResolution | undefined> {
  return resolveOutboundTargetWithPlugin({
    plugin: getLoadedChannelPluginForRead(params.channel),
    target: params,
  });
}

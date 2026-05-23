import type { ParsedChannelExplicitTarget } from "../../channels/plugins/target-parsing-loaded.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
export { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded-read.js";
export { mapAllowFromEntries } from "../../plugin-sdk/channel-config-helpers.js";
export { resolveFirstBoundAccountId } from "../../routing/bound-account-read.js";

export function parseExplicitTargetForDelivery(params: {
  cfg: OpenClawConfig;
  channel: string;
  rawTarget: string;
}): ParsedChannelExplicitTarget | null {
  return (
    resolveOutboundChannelPlugin({
      channel: params.channel,
      cfg: params.cfg,
      allowBootstrap: true,
    })?.messaging?.parseExplicitTarget?.({ raw: params.rawTarget }) ?? null
  );
}

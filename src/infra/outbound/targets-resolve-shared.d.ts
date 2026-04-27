import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
export type OutboundTargetResolution = {
    ok: true;
    to: string;
} | {
    ok: false;
    error: Error;
};
export type ResolveOutboundTargetParams = {
    channel: GatewayMessageChannel;
    to?: string;
    allowFrom?: string[];
    cfg?: OpenClawConfig;
    accountId?: string | null;
    mode?: ChannelOutboundTargetMode;
};
export declare function resolveOutboundTargetWithPlugin(params: {
    plugin: ChannelPlugin | undefined;
    target: ResolveOutboundTargetParams;
    onMissingPlugin?: () => OutboundTargetResolution | undefined;
}): OutboundTargetResolution | undefined;

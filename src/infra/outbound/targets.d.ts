import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.core.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { DeliverableMessageChannel, GatewayMessageChannel } from "../../utils/message-channel.js";
import { type OutboundTargetResolution } from "./targets-resolve-shared.js";
export type OutboundChannel = DeliverableMessageChannel;
export type HeartbeatTarget = OutboundChannel;
export type OutboundTarget = {
    channel: OutboundChannel;
    to?: string;
    reason?: string;
    accountId?: string;
    threadId?: string | number;
    lastChannel?: DeliverableMessageChannel;
    lastAccountId?: string;
};
export type HeartbeatSenderContext = {
    sender: string;
    provider?: DeliverableMessageChannel;
    allowFrom: string[];
};
export type { OutboundTargetResolution } from "./targets-resolve-shared.js";
export { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";
export declare function resolveOutboundTarget(params: {
    channel: GatewayMessageChannel;
    to?: string;
    allowFrom?: string[];
    cfg?: OpenClawConfig;
    accountId?: string | null;
    mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution;
export declare function resolveHeartbeatDeliveryTarget(params: {
    cfg: OpenClawConfig;
    entry?: SessionEntry;
    heartbeat?: AgentDefaultsConfig["heartbeat"];
    turnSource?: DeliveryContext;
}): OutboundTarget;
export declare function resolveHeartbeatSenderContext(params: {
    cfg: OpenClawConfig;
    entry?: SessionEntry;
    delivery: OutboundTarget;
}): HeartbeatSenderContext;

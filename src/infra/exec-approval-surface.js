import { getChannelPlugin, listChannelPlugins, resolveChannelApprovalCapability, } from "../channels/plugins/index.js";
import { loadConfig } from "../config/config.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { INTERNAL_MESSAGE_CHANNEL, isDeliverableMessageChannel, normalizeMessageChannel, } from "../utils/message-channel.js";
function labelForChannel(channel) {
    if (channel === "tui") {
        return "terminal UI";
    }
    if (channel === INTERNAL_MESSAGE_CHANNEL) {
        return "Web UI";
    }
    return (getChannelPlugin(channel ?? "")?.meta.label ??
        (channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform"));
}
function hasNativeExecApprovalCapability(channel) {
    const capability = resolveChannelApprovalCapability(getChannelPlugin(channel ?? ""));
    if (!capability?.native) {
        return false;
    }
    return Boolean(capability.getExecInitiatingSurfaceState || capability.getActionAvailabilityState);
}
export function resolveExecApprovalInitiatingSurfaceState(params) {
    const channel = normalizeMessageChannel(params.channel);
    const channelLabel = labelForChannel(channel);
    const accountId = normalizeOptionalString(params.accountId);
    if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
        return { kind: "enabled", channel, channelLabel, accountId };
    }
    const cfg = params.cfg ?? loadConfig();
    const capability = resolveChannelApprovalCapability(getChannelPlugin(channel));
    const state = capability?.getExecInitiatingSurfaceState?.({
        cfg,
        accountId: params.accountId,
        action: "approve",
    }) ??
        capability?.getActionAvailabilityState?.({
            cfg,
            accountId: params.accountId,
            action: "approve",
            approvalKind: "exec",
        });
    if (state) {
        return { ...state, channel, channelLabel, accountId };
    }
    if (isDeliverableMessageChannel(channel)) {
        return { kind: "enabled", channel, channelLabel, accountId };
    }
    return { kind: "unsupported", channel, channelLabel, accountId };
}
export function supportsNativeExecApprovalClient(channel) {
    const normalized = normalizeMessageChannel(channel);
    if (!normalized || normalized === INTERNAL_MESSAGE_CHANNEL || normalized === "tui") {
        return true;
    }
    return hasNativeExecApprovalCapability(normalized);
}
export function listNativeExecApprovalClientLabels(params) {
    const excludeChannel = normalizeMessageChannel(params?.excludeChannel);
    return listChannelPlugins()
        .filter((plugin) => plugin.id !== excludeChannel)
        .filter((plugin) => hasNativeExecApprovalCapability(plugin.id))
        .map((plugin) => normalizeOptionalString(plugin.meta.label))
        .filter((label) => Boolean(label))
        .toSorted((a, b) => a.localeCompare(b));
}
export function describeNativeExecApprovalClientSetup(params) {
    const channel = normalizeMessageChannel(params.channel);
    if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
        return null;
    }
    const channelLabel = normalizeOptionalString(params.channelLabel) ?? labelForChannel(channel);
    const accountId = normalizeOptionalString(params.accountId);
    return (resolveChannelApprovalCapability(getChannelPlugin(channel))?.describeExecApprovalSetup?.({
        channel,
        channelLabel,
        accountId,
    }) ?? null);
}

import { normalizeAccountId } from "../../utils/account-id.js";
import { INTERNAL_MESSAGE_CHANNEL, isDeliverableMessageChannel, isGatewayMessageChannel, normalizeMessageChannel, } from "../../utils/message-channel.js";
import { resolveOutboundTarget, resolveSessionDeliveryTarget, } from "./targets.js";
export function resolveAgentDeliveryPlan(params) {
    const requestedRaw = typeof params.requestedChannel === "string" ? params.requestedChannel.trim() : "";
    const normalizedRequested = requestedRaw ? normalizeMessageChannel(requestedRaw) : undefined;
    const requestedChannel = normalizedRequested || "last";
    const explicitTo = typeof params.explicitTo === "string" && params.explicitTo.trim()
        ? params.explicitTo.trim()
        : undefined;
    // Resolve turn-source channel for cross-channel safety.
    const normalizedTurnSource = params.turnSourceChannel
        ? normalizeMessageChannel(params.turnSourceChannel)
        : undefined;
    const turnSourceChannel = normalizedTurnSource && isDeliverableMessageChannel(normalizedTurnSource)
        ? normalizedTurnSource
        : undefined;
    const turnSourceTo = typeof params.turnSourceTo === "string" && params.turnSourceTo.trim()
        ? params.turnSourceTo.trim()
        : undefined;
    const turnSourceAccountId = normalizeAccountId(params.turnSourceAccountId);
    const turnSourceThreadId = params.turnSourceThreadId != null && params.turnSourceThreadId !== ""
        ? params.turnSourceThreadId
        : undefined;
    const baseDelivery = resolveSessionDeliveryTarget({
        entry: params.sessionEntry,
        requestedChannel: requestedChannel === INTERNAL_MESSAGE_CHANNEL ? "last" : requestedChannel,
        explicitTo,
        explicitThreadId: params.explicitThreadId,
        turnSourceChannel,
        turnSourceTo,
        turnSourceAccountId,
        turnSourceThreadId,
    });
    const resolvedChannel = (() => {
        if (requestedChannel === INTERNAL_MESSAGE_CHANNEL) {
            return INTERNAL_MESSAGE_CHANNEL;
        }
        if (requestedChannel === "last") {
            if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
                return baseDelivery.channel;
            }
            return INTERNAL_MESSAGE_CHANNEL;
        }
        if (isGatewayMessageChannel(requestedChannel)) {
            return requestedChannel;
        }
        if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
            return baseDelivery.channel;
        }
        return INTERNAL_MESSAGE_CHANNEL;
    })();
    const deliveryTargetMode = explicitTo
        ? "explicit"
        : isDeliverableMessageChannel(resolvedChannel)
            ? "implicit"
            : undefined;
    const resolvedAccountId = normalizeAccountId(params.accountId) ??
        (deliveryTargetMode === "implicit" ? baseDelivery.accountId : undefined);
    let resolvedTo = explicitTo;
    if (!resolvedTo &&
        isDeliverableMessageChannel(resolvedChannel) &&
        resolvedChannel === baseDelivery.lastChannel) {
        resolvedTo = baseDelivery.lastTo;
    }
    return {
        baseDelivery,
        resolvedChannel,
        resolvedTo,
        resolvedAccountId,
        resolvedThreadId: baseDelivery.threadId,
        deliveryTargetMode,
    };
}
export function resolveAgentOutboundTarget(params) {
    const targetMode = params.targetMode ??
        params.plan.deliveryTargetMode ??
        (params.plan.resolvedTo ? "explicit" : "implicit");
    if (!isDeliverableMessageChannel(params.plan.resolvedChannel)) {
        return {
            resolvedTarget: null,
            resolvedTo: params.plan.resolvedTo,
            targetMode,
        };
    }
    if (params.validateExplicitTarget !== true && params.plan.resolvedTo) {
        return {
            resolvedTarget: null,
            resolvedTo: params.plan.resolvedTo,
            targetMode,
        };
    }
    const resolvedTarget = resolveOutboundTarget({
        channel: params.plan.resolvedChannel,
        to: params.plan.resolvedTo,
        cfg: params.cfg,
        accountId: params.plan.resolvedAccountId,
        mode: targetMode,
    });
    return {
        resolvedTarget,
        resolvedTo: resolvedTarget.ok ? resolvedTarget.to : params.plan.resolvedTo,
        targetMode,
    };
}

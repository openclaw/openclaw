import { comparableChannelTargetsShareRoute, parseExplicitTargetForLoadedChannel, resolveComparableTargetForLoadedChannel, } from "../../channels/plugins/target-parsing-loaded.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel, normalizeMessageChannel, } from "../../utils/message-channel-core.js";
function parseExplicitTargetWithPlugin(params) {
    const raw = params.raw?.trim();
    if (!raw) {
        return null;
    }
    const provider = params.channel ?? params.fallbackChannel;
    if (!provider) {
        return null;
    }
    return parseExplicitTargetForLoadedChannel(provider, raw);
}
export function resolveSessionDeliveryTarget(params) {
    const context = deliveryContextFromSession(params.entry);
    const sessionLastChannel = context?.channel && isDeliverableMessageChannel(context.channel) ? context.channel : undefined;
    const parsedSessionTarget = sessionLastChannel
        ? resolveComparableTargetForLoadedChannel({
            channel: sessionLastChannel,
            rawTarget: context?.to,
            fallbackThreadId: context?.threadId,
        })
        : null;
    const hasTurnSourceChannel = params.turnSourceChannel != null;
    const parsedTurnSourceTarget = hasTurnSourceChannel && params.turnSourceChannel
        ? resolveComparableTargetForLoadedChannel({
            channel: params.turnSourceChannel,
            rawTarget: params.turnSourceTo,
            fallbackThreadId: params.turnSourceThreadId,
        })
        : null;
    const hasTurnSourceThreadId = parsedTurnSourceTarget?.threadId != null;
    const lastChannel = hasTurnSourceChannel ? params.turnSourceChannel : sessionLastChannel;
    const lastTo = hasTurnSourceChannel ? params.turnSourceTo : context?.to;
    const lastAccountId = hasTurnSourceChannel ? params.turnSourceAccountId : context?.accountId;
    const turnToMatchesSession = !params.turnSourceTo ||
        !context?.to ||
        (params.turnSourceChannel === sessionLastChannel &&
            comparableChannelTargetsShareRoute({
                left: parsedTurnSourceTarget,
                right: parsedSessionTarget,
            }));
    const lastThreadId = hasTurnSourceThreadId
        ? parsedTurnSourceTarget?.threadId
        : hasTurnSourceChannel &&
            (params.turnSourceChannel !== sessionLastChannel || !turnToMatchesSession)
            ? undefined
            : parsedSessionTarget?.threadId;
    const rawRequested = params.requestedChannel ?? "last";
    const requested = rawRequested === "last" ? "last" : normalizeMessageChannel(rawRequested);
    const requestedChannel = requested === "last"
        ? "last"
        : requested && isDeliverableMessageChannel(requested)
            ? requested
            : undefined;
    const rawExplicitTo = typeof params.explicitTo === "string" && params.explicitTo.trim()
        ? params.explicitTo.trim()
        : undefined;
    let channel = requestedChannel === "last" ? lastChannel : requestedChannel;
    if (!channel && params.fallbackChannel && isDeliverableMessageChannel(params.fallbackChannel)) {
        channel = params.fallbackChannel;
    }
    let explicitTo = rawExplicitTo;
    const parsedExplicitTarget = parseExplicitTargetWithPlugin({
        channel,
        fallbackChannel: !channel ? lastChannel : undefined,
        raw: rawExplicitTo,
    });
    if (parsedExplicitTarget?.to) {
        explicitTo = parsedExplicitTarget.to;
    }
    const explicitThreadId = params.explicitThreadId != null && params.explicitThreadId !== ""
        ? params.explicitThreadId
        : parsedExplicitTarget?.threadId;
    let to = explicitTo;
    if (!to && lastTo) {
        if (channel && channel === lastChannel) {
            to = lastTo;
        }
        else if (params.allowMismatchedLastTo) {
            to = lastTo;
        }
    }
    const mode = params.mode ?? (explicitTo ? "explicit" : "implicit");
    const accountId = channel && channel === lastChannel ? lastAccountId : undefined;
    const threadId = channel && channel === lastChannel
        ? mode === "heartbeat"
            ? hasTurnSourceThreadId
                ? params.turnSourceThreadId
                : undefined
            : lastThreadId
        : undefined;
    const resolvedThreadId = explicitThreadId ?? threadId;
    return {
        channel,
        to,
        accountId,
        threadId: resolvedThreadId,
        threadIdExplicit: resolvedThreadId != null && explicitThreadId != null,
        mode,
        lastChannel,
        lastTo,
        lastAccountId,
        lastThreadId,
    };
}

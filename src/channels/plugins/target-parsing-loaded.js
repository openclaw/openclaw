import { normalizeOptionalString, normalizeOptionalThreadValue, } from "../../shared/string-coerce.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded-read.js";
export function parseExplicitTargetForLoadedChannel(channel, rawTarget) {
    const resolvedChannel = normalizeOptionalString(channel);
    if (!resolvedChannel) {
        return null;
    }
    return (getLoadedChannelPluginForRead(resolvedChannel)?.messaging?.parseExplicitTarget?.({
        raw: rawTarget,
    }) ?? null);
}
export function resolveComparableTargetForLoadedChannel(params) {
    const rawTo = normalizeOptionalString(params.rawTarget);
    if (!rawTo) {
        return null;
    }
    const parsed = parseExplicitTargetForLoadedChannel(params.channel, rawTo);
    const fallbackThreadId = normalizeOptionalThreadValue(params.fallbackThreadId);
    return {
        rawTo,
        to: parsed?.to ?? rawTo,
        threadId: normalizeOptionalThreadValue(parsed?.threadId ?? fallbackThreadId),
        chatType: parsed?.chatType,
    };
}
export function comparableChannelTargetsMatch(params) {
    const left = params.left;
    const right = params.right;
    if (!left || !right) {
        return false;
    }
    return left.to === right.to && left.threadId === right.threadId;
}
export function comparableChannelTargetsShareRoute(params) {
    const left = params.left;
    const right = params.right;
    if (!left || !right) {
        return false;
    }
    if (left.to !== right.to) {
        return false;
    }
    if (left.threadId == null || right.threadId == null) {
        return true;
    }
    return left.threadId === right.threadId;
}

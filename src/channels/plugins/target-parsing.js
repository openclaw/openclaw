import { normalizeOptionalString, normalizeOptionalThreadValue, } from "../../shared/string-coerce.js";
import { normalizeChatChannelId } from "../registry.js";
import { getChannelPlugin, normalizeChannelId } from "./index.js";
export { comparableChannelTargetsMatch, comparableChannelTargetsShareRoute, parseExplicitTargetForLoadedChannel, resolveComparableTargetForLoadedChannel, } from "./target-parsing-loaded.js";
function parseWithPlugin(getPlugin, rawChannel, rawTarget) {
    const channel = normalizeChatChannelId(rawChannel) ?? normalizeChannelId(rawChannel);
    if (!channel) {
        return null;
    }
    return getPlugin(channel)?.messaging?.parseExplicitTarget?.({ raw: rawTarget }) ?? null;
}
export function parseExplicitTargetForChannel(channel, rawTarget) {
    return parseWithPlugin(getChannelPlugin, channel, rawTarget);
}
export function resolveComparableTargetForChannel(params) {
    const rawTo = normalizeOptionalString(params.rawTarget);
    if (!rawTo) {
        return null;
    }
    const parsed = parseExplicitTargetForChannel(params.channel, rawTo);
    const fallbackThreadId = normalizeOptionalThreadValue(params.fallbackThreadId);
    return {
        rawTo,
        to: parsed?.to ?? rawTo,
        threadId: normalizeOptionalThreadValue(parsed?.threadId ?? fallbackThreadId),
        chatType: parsed?.chatType,
    };
}

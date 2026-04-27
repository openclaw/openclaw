import { normalizeAnyChannelId } from "../channels/registry.js";
import { resolveLegacyOutboundSendDepKeys, } from "../infra/outbound/send-deps.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
function normalizeLegacyChannelStem(raw) {
    const normalized = normalizeLowercaseStringOrEmpty(raw
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/_/g, "-")
        .trim());
    return normalized.replace(/-/g, "");
}
function resolveChannelIdFromLegacySourceKey(key) {
    const match = key.match(/^sendMessage(.+)$/);
    if (!match) {
        return undefined;
    }
    const normalizedStem = normalizeLegacyChannelStem(match[1] ?? "");
    return normalizeAnyChannelId(normalizedStem) ?? (normalizedStem || undefined);
}
/**
 * Pass CLI send sources through as-is — both CliOutboundSendSource and
 * OutboundSendDeps are now channel-ID-keyed records.
 */
export function createOutboundSendDepsFromCliSource(deps) {
    const outbound = { ...deps };
    for (const legacySourceKey of Object.keys(deps)) {
        const channelId = resolveChannelIdFromLegacySourceKey(legacySourceKey);
        if (!channelId) {
            continue;
        }
        const sourceValue = deps[legacySourceKey];
        if (sourceValue !== undefined && outbound[channelId] === undefined) {
            outbound[channelId] = sourceValue;
        }
    }
    for (const channelId of Object.keys(outbound)) {
        const sourceValue = outbound[channelId];
        if (sourceValue === undefined) {
            continue;
        }
        for (const legacyDepKey of resolveLegacyOutboundSendDepKeys(channelId)) {
            if (outbound[legacyDepKey] === undefined) {
                outbound[legacyDepKey] = sourceValue;
            }
        }
    }
    return outbound;
}

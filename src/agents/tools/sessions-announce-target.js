import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { parseThreadSessionSuffix } from "../../sessions/session-key-utils.js";
import { normalizeOptionalStringifiedId } from "../../shared/string-coerce.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";
async function callGatewayLazy(opts) {
    const { callGateway } = await import("../../gateway/call.js");
    return callGateway(opts);
}
export async function resolveAnnounceTarget(params) {
    const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
    const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
    const fallback = parsed ?? parsedDisplay ?? null;
    const fallbackThreadId = fallback?.threadId ??
        parseThreadSessionSuffix(params.sessionKey).threadId ??
        parseThreadSessionSuffix(params.displayKey).threadId;
    if (fallback) {
        const normalized = normalizeChannelId(fallback.channel);
        const plugin = normalized ? getChannelPlugin(normalized) : null;
        if (!plugin?.meta?.preferSessionLookupForAnnounceTarget) {
            return fallback;
        }
    }
    try {
        const list = await callGatewayLazy({
            method: "sessions.list",
            params: {
                includeGlobal: true,
                includeUnknown: true,
                limit: 200,
            },
        });
        const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
        const match = sessions.find((entry) => entry?.key === params.sessionKey) ??
            sessions.find((entry) => entry?.key === params.displayKey);
        const deliveryContext = match?.deliveryContext && typeof match.deliveryContext === "object"
            ? match.deliveryContext
            : undefined;
        const origin = match?.origin && typeof match.origin === "object"
            ? match.origin
            : undefined;
        const channel = (typeof deliveryContext?.channel === "string" ? deliveryContext.channel : undefined) ??
            (typeof match?.lastChannel === "string" ? match.lastChannel : undefined) ??
            (typeof origin?.provider === "string" ? origin.provider : undefined);
        const to = (typeof deliveryContext?.to === "string" ? deliveryContext.to : undefined) ??
            (typeof match?.lastTo === "string" ? match.lastTo : undefined);
        const accountId = (typeof deliveryContext?.accountId === "string" ? deliveryContext.accountId : undefined) ??
            (typeof match?.lastAccountId === "string" ? match.lastAccountId : undefined) ??
            (typeof origin?.accountId === "string" ? origin.accountId : undefined);
        const threadId = normalizeOptionalStringifiedId(deliveryContext?.threadId ?? match?.lastThreadId ?? origin?.threadId ?? fallbackThreadId);
        if (channel && to) {
            return { channel, to, accountId, threadId };
        }
    }
    catch {
        // ignore
    }
    return fallback;
}

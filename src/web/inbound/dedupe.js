import { createDedupeCache } from "../../infra/dedupe.js";
const RECENT_WEB_MESSAGE_TTL_MS = 20 * 60000;
const RECENT_WEB_MESSAGE_MAX = 5000;
const recentInboundMessages = createDedupeCache({
    ttlMs: RECENT_WEB_MESSAGE_TTL_MS,
    maxSize: RECENT_WEB_MESSAGE_MAX,
});
export function resetWebInboundDedupe() {
    recentInboundMessages.clear();
}
export function isRecentInboundMessage(key) {
    return recentInboundMessages.check(key);
}

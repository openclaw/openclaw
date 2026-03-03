const SENT_MESSAGE_TEXT_TTL_MS = 5000;
const SENT_MESSAGE_ID_TTL_MS = 60000;
function normalizeEchoTextKey(text) {
    if (!text) {
        return null;
    }
    const normalized = text.replace(/\r\n?/g, "\n").trim();
    return normalized ? normalized : null;
}
function normalizeEchoMessageIdKey(messageId) {
    if (!messageId) {
        return null;
    }
    const normalized = messageId.trim();
    if (!normalized || normalized === "ok" || normalized === "unknown") {
        return null;
    }
    return normalized;
}
class DefaultSentMessageCache {
    textCache = new Map();
    messageIdCache = new Map();
    remember(scope, lookup) {
        const textKey = normalizeEchoTextKey(lookup.text);
        if (textKey) {
            this.textCache.set(`${scope}:${textKey}`, Date.now());
        }
        const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
        if (messageIdKey) {
            this.messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
        }
        this.cleanup();
    }
    has(scope, lookup) {
        this.cleanup();
        const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
        if (messageIdKey) {
            const idTimestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
            if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) {
                return true;
            }
        }
        const textKey = normalizeEchoTextKey(lookup.text);
        if (textKey) {
            const textTimestamp = this.textCache.get(`${scope}:${textKey}`);
            if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
                return true;
            }
        }
        return false;
    }
    cleanup() {
        const now = Date.now();
        for (const [key, timestamp] of this.textCache.entries()) {
            if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
                this.textCache.delete(key);
            }
        }
        for (const [key, timestamp] of this.messageIdCache.entries()) {
            if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) {
                this.messageIdCache.delete(key);
            }
        }
    }
}
export function createSentMessageCache() {
    return new DefaultSentMessageCache();
}

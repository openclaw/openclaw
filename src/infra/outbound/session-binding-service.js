import { normalizeAccountId } from "../../routing/session-key.js";
export class SessionBindingError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "SessionBindingError";
    }
}
export function isSessionBindingError(error) {
    return error instanceof SessionBindingError;
}
function normalizeConversationRef(ref) {
    return {
        channel: ref.channel.trim().toLowerCase(),
        accountId: normalizeAccountId(ref.accountId),
        conversationId: ref.conversationId.trim(),
        parentConversationId: ref.parentConversationId?.trim() || undefined,
    };
}
function toAdapterKey(params) {
    return `${params.channel.trim().toLowerCase()}:${normalizeAccountId(params.accountId)}`;
}
function normalizePlacement(raw) {
    return raw === "current" || raw === "child" ? raw : undefined;
}
function inferDefaultPlacement(ref) {
    return ref.conversationId ? "current" : "child";
}
function resolveAdapterPlacements(adapter) {
    const configured = adapter.capabilities?.placements?.map((value) => normalizePlacement(value));
    const placements = configured?.filter((value) => Boolean(value));
    if (placements && placements.length > 0) {
        return [...new Set(placements)];
    }
    return ["current", "child"];
}
function resolveAdapterCapabilities(adapter) {
    if (!adapter) {
        return {
            adapterAvailable: false,
            bindSupported: false,
            unbindSupported: false,
            placements: [],
        };
    }
    const bindSupported = adapter.capabilities?.bindSupported ?? Boolean(adapter.bind);
    return {
        adapterAvailable: true,
        bindSupported,
        unbindSupported: adapter.capabilities?.unbindSupported ?? Boolean(adapter.unbind),
        placements: bindSupported ? resolveAdapterPlacements(adapter) : [],
    };
}
const ADAPTERS_BY_CHANNEL_ACCOUNT = new Map();
export function registerSessionBindingAdapter(adapter) {
    const key = toAdapterKey({
        channel: adapter.channel,
        accountId: adapter.accountId,
    });
    ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, {
        ...adapter,
        channel: adapter.channel.trim().toLowerCase(),
        accountId: normalizeAccountId(adapter.accountId),
    });
}
export function unregisterSessionBindingAdapter(params) {
    ADAPTERS_BY_CHANNEL_ACCOUNT.delete(toAdapterKey(params));
}
function resolveAdapterForConversation(ref) {
    return resolveAdapterForChannelAccount({
        channel: ref.channel,
        accountId: ref.accountId,
    });
}
function resolveAdapterForChannelAccount(params) {
    const key = toAdapterKey({
        channel: params.channel,
        accountId: params.accountId,
    });
    return ADAPTERS_BY_CHANNEL_ACCOUNT.get(key) ?? null;
}
function dedupeBindings(records) {
    const byId = new Map();
    for (const record of records) {
        if (!record?.bindingId) {
            continue;
        }
        byId.set(record.bindingId, record);
    }
    return [...byId.values()];
}
function createDefaultSessionBindingService() {
    return {
        bind: async (input) => {
            const normalizedConversation = normalizeConversationRef(input.conversation);
            const adapter = resolveAdapterForConversation(normalizedConversation);
            if (!adapter) {
                throw new SessionBindingError("BINDING_ADAPTER_UNAVAILABLE", `Session binding adapter unavailable for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
                    channel: normalizedConversation.channel,
                    accountId: normalizedConversation.accountId,
                });
            }
            if (!adapter.bind) {
                throw new SessionBindingError("BINDING_CAPABILITY_UNSUPPORTED", `Session binding adapter does not support binding for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
                    channel: normalizedConversation.channel,
                    accountId: normalizedConversation.accountId,
                });
            }
            const placement = normalizePlacement(input.placement) ?? inferDefaultPlacement(normalizedConversation);
            const supportedPlacements = resolveAdapterPlacements(adapter);
            if (!supportedPlacements.includes(placement)) {
                throw new SessionBindingError("BINDING_CAPABILITY_UNSUPPORTED", `Session binding placement "${placement}" is not supported for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
                    channel: normalizedConversation.channel,
                    accountId: normalizedConversation.accountId,
                    placement,
                });
            }
            const bound = await adapter.bind({
                ...input,
                conversation: normalizedConversation,
                placement,
            });
            if (!bound) {
                throw new SessionBindingError("BINDING_CREATE_FAILED", "Session binding adapter failed to bind target conversation", {
                    channel: normalizedConversation.channel,
                    accountId: normalizedConversation.accountId,
                    placement,
                });
            }
            return bound;
        },
        getCapabilities: (params) => {
            const adapter = resolveAdapterForChannelAccount({
                channel: params.channel,
                accountId: params.accountId,
            });
            return resolveAdapterCapabilities(adapter);
        },
        listBySession: (targetSessionKey) => {
            const key = targetSessionKey.trim();
            if (!key) {
                return [];
            }
            const results = [];
            for (const adapter of ADAPTERS_BY_CHANNEL_ACCOUNT.values()) {
                const entries = adapter.listBySession(key);
                if (entries.length > 0) {
                    results.push(...entries);
                }
            }
            return dedupeBindings(results);
        },
        resolveByConversation: (ref) => {
            const normalized = normalizeConversationRef(ref);
            if (!normalized.channel || !normalized.conversationId) {
                return null;
            }
            const adapter = resolveAdapterForConversation(normalized);
            if (!adapter) {
                return null;
            }
            return adapter.resolveByConversation(normalized);
        },
        touch: (bindingId, at) => {
            const normalizedBindingId = bindingId.trim();
            if (!normalizedBindingId) {
                return;
            }
            for (const adapter of ADAPTERS_BY_CHANNEL_ACCOUNT.values()) {
                adapter.touch?.(normalizedBindingId, at);
            }
        },
        unbind: async (input) => {
            const removed = [];
            for (const adapter of ADAPTERS_BY_CHANNEL_ACCOUNT.values()) {
                if (!adapter.unbind) {
                    continue;
                }
                const entries = await adapter.unbind(input);
                if (entries.length > 0) {
                    removed.push(...entries);
                }
            }
            return dedupeBindings(removed);
        },
    };
}
const DEFAULT_SESSION_BINDING_SERVICE = createDefaultSessionBindingService();
export function getSessionBindingService() {
    return DEFAULT_SESSION_BINDING_SERVICE;
}
export const __testing = {
    resetSessionBindingAdaptersForTests() {
        ADAPTERS_BY_CHANNEL_ACCOUNT.clear();
    },
    getRegisteredAdapterKeys() {
        return [...ADAPTERS_BY_CHANNEL_ACCOUNT.keys()];
    },
};

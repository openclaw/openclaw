import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { __testing as genericCurrentConversationBindingTesting, bindGenericCurrentConversation, getGenericCurrentConversationBindingCapabilities, listGenericCurrentConversationBindingsBySession, resolveGenericCurrentConversationBinding, touchGenericCurrentConversationBinding, unbindGenericCurrentConversationBindings, } from "./current-conversation-bindings.js";
import { buildChannelAccountKey, normalizeConversationRef, } from "./session-binding-normalization.js";
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
function toAdapterKey(params) {
    return buildChannelAccountKey(params);
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
const SESSION_BINDING_ADAPTERS_KEY = Symbol.for("openclaw.sessionBinding.adapters");
const ADAPTERS_BY_CHANNEL_ACCOUNT = resolveGlobalMap(SESSION_BINDING_ADAPTERS_KEY);
function getActiveAdapterForKey(key) {
    const registrations = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
    return registrations?.at(-1)?.normalizedAdapter ?? null;
}
export function registerSessionBindingAdapter(adapter) {
    const normalizedAdapter = {
        ...adapter,
        ...normalizeConversationRef({
            channel: adapter.channel,
            accountId: adapter.accountId,
            conversationId: "unused",
        }),
    };
    const key = toAdapterKey({
        channel: normalizedAdapter.channel,
        accountId: normalizedAdapter.accountId,
    });
    const existing = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
    const registrations = existing ? [...existing] : [];
    registrations.push({
        adapter,
        normalizedAdapter,
    });
    ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, registrations);
}
export function unregisterSessionBindingAdapter(params) {
    const key = toAdapterKey(params);
    const registrations = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
    if (!registrations || registrations.length === 0) {
        return;
    }
    const nextRegistrations = [...registrations];
    if (params.adapter) {
        // Remove the matching owner so a surviving duplicate graph can stay active.
        const registrationIndex = nextRegistrations.findLastIndex((registration) => registration.adapter === params.adapter);
        if (registrationIndex < 0) {
            return;
        }
        nextRegistrations.splice(registrationIndex, 1);
    }
    else {
        nextRegistrations.pop();
    }
    if (nextRegistrations.length === 0) {
        ADAPTERS_BY_CHANNEL_ACCOUNT.delete(key);
        return;
    }
    ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, nextRegistrations);
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
    return getActiveAdapterForKey(key);
}
function getActiveRegisteredAdapters() {
    return [...ADAPTERS_BY_CHANNEL_ACCOUNT.values()]
        .map((registrations) => registrations.at(-1)?.normalizedAdapter ?? null)
        .filter((adapter) => Boolean(adapter));
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
                const genericCapabilities = getGenericCurrentConversationBindingCapabilities({
                    channel: normalizedConversation.channel,
                    accountId: normalizedConversation.accountId,
                });
                if (genericCapabilities?.bindSupported) {
                    const placement = normalizePlacement(input.placement) ?? inferDefaultPlacement(normalizedConversation);
                    if (placement !== "current") {
                        throw new SessionBindingError("BINDING_CAPABILITY_UNSUPPORTED", `Session binding placement "${placement}" is not supported for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
                            channel: normalizedConversation.channel,
                            accountId: normalizedConversation.accountId,
                            placement,
                        });
                    }
                    const bound = await bindGenericCurrentConversation({
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
                }
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
            if (!adapter) {
                return (getGenericCurrentConversationBindingCapabilities(params) ?? {
                    adapterAvailable: false,
                    bindSupported: false,
                    unbindSupported: false,
                    placements: [],
                });
            }
            return resolveAdapterCapabilities(adapter);
        },
        listBySession: (targetSessionKey) => {
            const key = targetSessionKey.trim();
            if (!key) {
                return [];
            }
            const results = [];
            for (const adapter of getActiveRegisteredAdapters()) {
                const entries = adapter.listBySession(key);
                if (entries.length > 0) {
                    results.push(...entries);
                }
            }
            results.push(...listGenericCurrentConversationBindingsBySession(key));
            return dedupeBindings(results);
        },
        resolveByConversation: (ref) => {
            const normalized = normalizeConversationRef(ref);
            if (!normalized.channel || !normalized.conversationId) {
                return null;
            }
            const adapter = resolveAdapterForConversation(normalized);
            if (!adapter) {
                return resolveGenericCurrentConversationBinding(normalized);
            }
            return adapter.resolveByConversation(normalized);
        },
        touch: (bindingId, at) => {
            const normalizedBindingId = bindingId.trim();
            if (!normalizedBindingId) {
                return;
            }
            for (const adapter of getActiveRegisteredAdapters()) {
                adapter.touch?.(normalizedBindingId, at);
            }
            touchGenericCurrentConversationBinding(normalizedBindingId, at);
        },
        unbind: async (input) => {
            const removed = [];
            for (const adapter of getActiveRegisteredAdapters()) {
                if (!adapter.unbind) {
                    continue;
                }
                const entries = await adapter.unbind(input);
                if (entries.length > 0) {
                    removed.push(...entries);
                }
            }
            removed.push(...(await unbindGenericCurrentConversationBindings(input)));
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
        genericCurrentConversationBindingTesting.resetCurrentConversationBindingsForTests({
            deletePersistedFile: true,
        });
    },
    getRegisteredAdapterKeys() {
        return [...ADAPTERS_BY_CHANNEL_ACCOUNT.keys()];
    },
};

let runtimeMod;
async function getRuntime() {
    if (!runtimeMod) {
        runtimeMod = (await import("./embedded-gateway-stub.runtime.js"));
    }
    return runtimeMod;
}
async function handleSessionsList(params) {
    const rt = await getRuntime();
    const cfg = rt.loadConfig();
    const { storePath, store } = rt.loadCombinedSessionStoreForGateway(cfg);
    return rt.listSessionsFromStore({
        cfg,
        storePath,
        store,
        opts: params,
    });
}
async function handleSessionsResolve(params) {
    const rt = await getRuntime();
    const cfg = rt.loadConfig();
    const resolved = await rt.resolveSessionKeyFromResolveParams({
        cfg,
        p: params,
    });
    if (!resolved.ok) {
        throw new Error(resolved.error.message);
    }
    return { ok: true, key: resolved.key };
}
async function handleChatHistory(params) {
    const rt = await getRuntime();
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const { cfg, storePath, entry } = rt.loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const sessionAgentId = rt.resolveSessionAgentId({ sessionKey, config: cfg });
    const resolvedSessionModel = rt.resolveSessionModelRef(cfg, entry, sessionAgentId);
    const localMessages = sessionId && storePath
        ? rt.readSessionMessages(sessionId, storePath, entry?.sessionFile)
        : [];
    const rawMessages = rt.augmentChatHistoryWithCliSessionImports({
        entry,
        provider: resolvedSessionModel.provider,
        localMessages,
    });
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const sanitized = rt.stripEnvelopeFromMessages(sliced);
    const normalized = rt.augmentChatHistoryWithCanvasBlocks(rt.sanitizeChatHistoryMessages(sanitized, effectiveMaxChars));
    const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
    const perMessageHardCap = Math.min(rt.CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    const replaced = rt.replaceOversizedChatHistoryMessages({
        messages: normalized,
        maxSingleMessageBytes: perMessageHardCap,
    });
    const capped = rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    const bounded = rt.enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
    return {
        sessionKey,
        sessionId,
        messages: bounded.messages,
        thinkingLevel: entry?.thinkingLevel,
        fastMode: entry?.fastMode,
        verboseLevel: entry?.verboseLevel,
    };
}
export function createEmbeddedCallGateway() {
    return async (opts) => {
        const method = opts.method?.trim();
        const params = (opts.params ?? {});
        switch (method) {
            case "sessions.list":
                return (await handleSessionsList(params));
            case "sessions.resolve":
                return (await handleSessionsResolve(params));
            case "chat.history":
                return (await handleChatHistory(params));
            default:
                throw new Error(`Method "${method}" requires a running gateway (unavailable in local embedded mode).`);
        }
    };
}

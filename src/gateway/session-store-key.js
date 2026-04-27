import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { canonicalizeMainSessionAlias, resolveMainSessionKey, } from "../config/sessions/main-session.js";
import { DEFAULT_AGENT_ID, normalizeAgentId, normalizeMainKey, parseAgentSessionKey, } from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../shared/string-coerce.js";
export function canonicalizeSessionKeyForAgent(agentId, key) {
    const lowered = normalizeLowercaseStringOrEmpty(key);
    if (lowered === "global" || lowered === "unknown") {
        return lowered;
    }
    if (lowered.startsWith("agent:")) {
        return lowered;
    }
    return `agent:${normalizeAgentId(agentId)}:${lowered}`;
}
function resolveDefaultStoreAgentId(cfg) {
    return normalizeAgentId(resolveDefaultAgentId(cfg));
}
function shouldRemapLegacyDefaultMainAlias(cfg, parsed, options) {
    const agentId = normalizeAgentId(parsed.agentId);
    if (agentId !== DEFAULT_AGENT_ID || listAgentIds(cfg).includes(DEFAULT_AGENT_ID)) {
        return false;
    }
    const defaultAgentId = resolveDefaultStoreAgentId(cfg);
    if (options?.storeAgentId && normalizeAgentId(options.storeAgentId) !== defaultAgentId) {
        return false;
    }
    const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
    const mainKey = normalizeMainKey(cfg.session?.mainKey);
    return rest === "main" || rest === mainKey;
}
function resolveParsedSessionStoreKey(cfg, raw, parsed, options) {
    if (!shouldRemapLegacyDefaultMainAlias(cfg, parsed, options)) {
        return {
            agentId: normalizeAgentId(parsed.agentId),
            sessionKey: normalizeLowercaseStringOrEmpty(raw),
        };
    }
    const agentId = resolveDefaultStoreAgentId(cfg);
    const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
    return { agentId, sessionKey: `agent:${agentId}:${rest}` };
}
export function resolveSessionStoreKey(params) {
    const raw = normalizeOptionalString(params.sessionKey) ?? "";
    if (!raw) {
        return raw;
    }
    const rawLower = normalizeLowercaseStringOrEmpty(raw);
    if (rawLower === "global" || rawLower === "unknown") {
        return rawLower;
    }
    const parsed = parseAgentSessionKey(raw);
    if (parsed) {
        const resolved = resolveParsedSessionStoreKey(params.cfg, raw, parsed, {
            storeAgentId: params.storeAgentId,
        });
        const canonical = canonicalizeMainSessionAlias({
            cfg: params.cfg,
            agentId: resolved.agentId,
            sessionKey: resolved.sessionKey,
        });
        if (canonical !== resolved.sessionKey) {
            return canonical;
        }
        return resolved.sessionKey;
    }
    const lowered = normalizeLowercaseStringOrEmpty(raw);
    const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
    if (lowered === "main" || lowered === rawMainKey) {
        return resolveMainSessionKey(params.cfg);
    }
    const agentId = resolveDefaultStoreAgentId(params.cfg);
    return canonicalizeSessionKeyForAgent(agentId, lowered);
}
export function resolveSessionStoreAgentId(cfg, canonicalKey) {
    if (canonicalKey === "global" || canonicalKey === "unknown") {
        return resolveDefaultStoreAgentId(cfg);
    }
    const parsed = parseAgentSessionKey(canonicalKey);
    if (parsed?.agentId) {
        return normalizeAgentId(parsed.agentId);
    }
    return resolveDefaultStoreAgentId(cfg);
}
export function resolveStoredSessionKeyForAgentStore(params) {
    const raw = normalizeOptionalString(params.sessionKey) ?? "";
    if (!raw) {
        return raw;
    }
    const lowered = normalizeLowercaseStringOrEmpty(raw);
    if (lowered === "global" || lowered === "unknown") {
        return lowered;
    }
    const key = parseAgentSessionKey(raw) ? raw : canonicalizeSessionKeyForAgent(params.agentId, raw);
    return resolveSessionStoreKey({
        cfg: params.cfg,
        sessionKey: key,
        storeAgentId: params.agentId,
    });
}
export function resolveStoredSessionOwnerAgentId(params) {
    const canonicalKey = resolveStoredSessionKeyForAgentStore(params);
    if (canonicalKey === "global" || canonicalKey === "unknown") {
        return null;
    }
    return resolveSessionStoreAgentId(params.cfg, canonicalKey);
}
export function canonicalizeSpawnedByForAgent(cfg, agentId, spawnedBy) {
    const raw = normalizeOptionalString(spawnedBy) ?? "";
    if (!raw) {
        return undefined;
    }
    const lower = normalizeLowercaseStringOrEmpty(raw);
    if (lower === "global" || lower === "unknown") {
        return lower;
    }
    let result;
    if (lower.startsWith("agent:")) {
        result = lower;
    }
    else {
        result = `agent:${normalizeAgentId(agentId)}:${lower}`;
    }
    // Resolve main-alias references (e.g. agent:ops:main -> configured main key).
    const parsed = parseAgentSessionKey(result);
    const resolvedAgent = parsed?.agentId ? normalizeAgentId(parsed.agentId) : agentId;
    return canonicalizeMainSessionAlias({ cfg, agentId: resolvedAgent, sessionKey: result });
}

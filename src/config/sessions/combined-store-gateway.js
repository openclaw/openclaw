import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { canonicalizeSpawnedByForAgent, resolveStoredSessionKeyForAgentStore, } from "../../gateway/session-store-key.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store-load.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
function isStorePathTemplate(store) {
    return typeof store === "string" && store.includes("{agentId}");
}
function mergeSessionEntryIntoCombined(params) {
    const { cfg, combined, entry, agentId, canonicalKey } = params;
    const existing = combined[canonicalKey];
    if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
        combined[canonicalKey] = {
            ...entry,
            ...existing,
            spawnedBy: canonicalizeSpawnedByForAgent(cfg, agentId, existing.spawnedBy ?? entry.spawnedBy),
        };
    }
    else {
        combined[canonicalKey] = {
            ...existing,
            ...entry,
            spawnedBy: canonicalizeSpawnedByForAgent(cfg, agentId, entry.spawnedBy ?? existing?.spawnedBy),
        };
    }
}
export function loadCombinedSessionStoreForGateway(cfg) {
    const storeConfig = cfg.session?.store;
    if (storeConfig && !isStorePathTemplate(storeConfig)) {
        const storePath = resolveStorePath(storeConfig);
        const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
        const store = loadSessionStore(storePath);
        const combined = {};
        for (const [key, entry] of Object.entries(store)) {
            const canonicalKey = resolveStoredSessionKeyForAgentStore({
                cfg,
                agentId: defaultAgentId,
                sessionKey: key,
            });
            mergeSessionEntryIntoCombined({
                cfg,
                combined,
                entry,
                agentId: defaultAgentId,
                canonicalKey,
            });
        }
        return { storePath, store: combined };
    }
    const targets = resolveAllAgentSessionStoreTargetsSync(cfg);
    const combined = {};
    for (const target of targets) {
        const agentId = target.agentId;
        const storePath = target.storePath;
        const store = loadSessionStore(storePath);
        for (const [key, entry] of Object.entries(store)) {
            const canonicalKey = resolveStoredSessionKeyForAgentStore({
                cfg,
                agentId,
                sessionKey: key,
            });
            mergeSessionEntryIntoCombined({
                cfg,
                combined,
                entry,
                agentId,
                canonicalKey,
            });
        }
    }
    const storePath = typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)";
    return { storePath, store: combined };
}

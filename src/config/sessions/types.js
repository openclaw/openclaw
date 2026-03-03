import crypto from "node:crypto";
function normalizeRuntimeField(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
export function normalizeSessionRuntimeModelFields(entry) {
    const normalizedModel = normalizeRuntimeField(entry.model);
    const normalizedProvider = normalizeRuntimeField(entry.modelProvider);
    let next = entry;
    if (!normalizedModel) {
        if (entry.model !== undefined || entry.modelProvider !== undefined) {
            next = { ...next };
            delete next.model;
            delete next.modelProvider;
        }
        return next;
    }
    if (entry.model !== normalizedModel) {
        if (next === entry) {
            next = { ...next };
        }
        next.model = normalizedModel;
    }
    if (!normalizedProvider) {
        if (entry.modelProvider !== undefined) {
            if (next === entry) {
                next = { ...next };
            }
            delete next.modelProvider;
        }
        return next;
    }
    if (entry.modelProvider !== normalizedProvider) {
        if (next === entry) {
            next = { ...next };
        }
        next.modelProvider = normalizedProvider;
    }
    return next;
}
export function setSessionRuntimeModel(entry, runtime) {
    const provider = runtime.provider.trim();
    const model = runtime.model.trim();
    if (!provider || !model) {
        return false;
    }
    entry.modelProvider = provider;
    entry.model = model;
    return true;
}
export function mergeSessionEntry(existing, patch) {
    const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
    const updatedAt = Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now());
    if (!existing) {
        return normalizeSessionRuntimeModelFields({ ...patch, sessionId, updatedAt });
    }
    const next = { ...existing, ...patch, sessionId, updatedAt };
    // Guard against stale provider carry-over when callers patch runtime model
    // without also patching runtime provider.
    if (Object.hasOwn(patch, "model") && !Object.hasOwn(patch, "modelProvider")) {
        const patchedModel = normalizeRuntimeField(patch.model);
        const existingModel = normalizeRuntimeField(existing.model);
        if (patchedModel && patchedModel !== existingModel) {
            delete next.modelProvider;
        }
    }
    return normalizeSessionRuntimeModelFields(next);
}
export function resolveFreshSessionTotalTokens(entry) {
    const total = entry?.totalTokens;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
        return undefined;
    }
    if (entry?.totalTokensFresh === false) {
        return undefined;
    }
    return total;
}
export function isSessionTotalTokensFresh(entry) {
    return resolveFreshSessionTotalTokens(entry) !== undefined;
}
export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;

import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
export function normalizeStoreSessionKey(sessionKey) {
    return normalizeLowercaseStringOrEmpty(sessionKey);
}
export function resolveSessionStoreEntry(params) {
    const trimmedKey = params.sessionKey.trim();
    const normalizedKey = normalizeStoreSessionKey(trimmedKey);
    const legacyKeySet = new Set();
    if (trimmedKey !== normalizedKey &&
        Object.prototype.hasOwnProperty.call(params.store, trimmedKey)) {
        legacyKeySet.add(trimmedKey);
    }
    let existing = params.store[normalizedKey] ?? (legacyKeySet.size > 0 ? params.store[trimmedKey] : undefined);
    let existingUpdatedAt = existing?.updatedAt ?? 0;
    for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
        if (candidateKey === normalizedKey) {
            continue;
        }
        if (normalizeStoreSessionKey(candidateKey) !== normalizedKey) {
            continue;
        }
        legacyKeySet.add(candidateKey);
        const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
        if (!existing || candidateUpdatedAt > existingUpdatedAt) {
            existing = candidateEntry;
            existingUpdatedAt = candidateUpdatedAt;
        }
    }
    return {
        normalizedKey,
        existing,
        legacyKeys: [...legacyKeySet],
    };
}

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;
const componentEntries = new Map();
const modalEntries = new Map();
function isExpired(entry, now) {
    return typeof entry.expiresAt === "number" && entry.expiresAt <= now;
}
function normalizeEntryTimestamps(entry, now, ttlMs) {
    const createdAt = entry.createdAt ?? now;
    const expiresAt = entry.expiresAt ?? createdAt + ttlMs;
    return { ...entry, createdAt, expiresAt };
}
export function registerDiscordComponentEntries(params) {
    const now = Date.now();
    const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
    for (const entry of params.entries) {
        const normalized = normalizeEntryTimestamps({ ...entry, messageId: params.messageId ?? entry.messageId }, now, ttlMs);
        componentEntries.set(entry.id, normalized);
    }
    for (const modal of params.modals) {
        const normalized = normalizeEntryTimestamps({ ...modal, messageId: params.messageId ?? modal.messageId }, now, ttlMs);
        modalEntries.set(modal.id, normalized);
    }
}
export function resolveDiscordComponentEntry(params) {
    const entry = componentEntries.get(params.id);
    if (!entry) {
        return null;
    }
    const now = Date.now();
    if (isExpired(entry, now)) {
        componentEntries.delete(params.id);
        return null;
    }
    if (params.consume !== false) {
        componentEntries.delete(params.id);
    }
    return entry;
}
export function resolveDiscordModalEntry(params) {
    const entry = modalEntries.get(params.id);
    if (!entry) {
        return null;
    }
    const now = Date.now();
    if (isExpired(entry, now)) {
        modalEntries.delete(params.id);
        return null;
    }
    if (params.consume !== false) {
        modalEntries.delete(params.id);
    }
    return entry;
}
export function clearDiscordComponentEntries() {
    componentEntries.clear();
    modalEntries.clear();
}

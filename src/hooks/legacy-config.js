export function getLegacyInternalHookHandlers(config) {
    const handlers = config?.hooks?.internal?.handlers;
    return Array.isArray(handlers) ? handlers : [];
}

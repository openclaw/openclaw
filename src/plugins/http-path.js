export function normalizePluginHttpPath(path, fallback) {
    const trimmed = path?.trim();
    if (!trimmed) {
        const fallbackTrimmed = fallback?.trim();
        if (!fallbackTrimmed) {
            return null;
        }
        return fallbackTrimmed.startsWith("/") ? fallbackTrimmed : `/${fallbackTrimmed}`;
    }
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

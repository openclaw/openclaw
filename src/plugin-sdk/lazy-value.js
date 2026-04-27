export function createCachedLazyValueGetter(value, fallback) {
    let resolved = false;
    let cached;
    return () => {
        if (!resolved) {
            const nextValue = typeof value === "function" ? value() : value;
            cached = nextValue ?? fallback;
            resolved = true;
        }
        return cached;
    };
}

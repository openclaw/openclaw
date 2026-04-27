export function uniqueStrings(values, normalize = (value) => value) {
    const result = [];
    const seen = new Set();
    for (const value of values ?? []) {
        const normalized = normalize(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

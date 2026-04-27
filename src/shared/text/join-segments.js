export function concatOptionalTextSegments(params) {
    const separator = params.separator ?? "\n\n";
    if (params.left && params.right) {
        return `${params.left}${separator}${params.right}`;
    }
    return params.right ?? params.left;
}
export function joinPresentTextSegments(segments, options) {
    const separator = options?.separator ?? "\n\n";
    const trim = options?.trim ?? false;
    const values = [];
    for (const segment of segments) {
        if (typeof segment !== "string") {
            continue;
        }
        const normalized = trim ? segment.trim() : segment;
        if (!normalized) {
            continue;
        }
        values.push(normalized);
    }
    return values.length > 0 ? values.join(separator) : undefined;
}

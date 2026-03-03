export function readBooleanParam(params, key) {
    const raw = params[key];
    if (typeof raw === "boolean") {
        return raw;
    }
    if (typeof raw === "string") {
        const trimmed = raw.trim().toLowerCase();
        if (trimmed === "true") {
            return true;
        }
        if (trimmed === "false") {
            return false;
        }
    }
    return undefined;
}

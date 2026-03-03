export function toStringEnv(env) {
    if (!env) {
        return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
            continue;
        }
        out[key] = String(value);
    }
    return out;
}

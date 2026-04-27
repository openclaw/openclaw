import { normalizeAgentId } from "../routing/session-key.js";
export function resolveAllowedAgentIds(raw) {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const allowed = new Set();
    let hasWildcard = false;
    for (const entry of raw) {
        const trimmed = entry.trim();
        if (!trimmed) {
            continue;
        }
        if (trimmed === "*") {
            hasWildcard = true;
            break;
        }
        allowed.add(normalizeAgentId(trimmed));
    }
    if (hasWildcard) {
        return undefined;
    }
    return allowed;
}

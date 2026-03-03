import { normalizeCommandBody } from "./commands-registry.js";
export function normalizeGroupActivation(raw) {
    const value = raw?.trim().toLowerCase();
    if (value === "mention") {
        return "mention";
    }
    if (value === "always") {
        return "always";
    }
    return undefined;
}
export function parseActivationCommand(raw) {
    if (!raw) {
        return { hasCommand: false };
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return { hasCommand: false };
    }
    const normalized = normalizeCommandBody(trimmed);
    const match = normalized.match(/^\/activation(?:\s+([a-zA-Z]+))?\s*$/i);
    if (!match) {
        return { hasCommand: false };
    }
    const mode = normalizeGroupActivation(match[1]);
    return { hasCommand: true, mode };
}

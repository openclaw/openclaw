import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
export function resolveHookExternalContentSource(sessionKey) {
    const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
    if (normalized.startsWith("hook:gmail:")) {
        return "gmail";
    }
    if (normalized.startsWith("hook:webhook:") || normalized.startsWith("hook:")) {
        return "webhook";
    }
    return undefined;
}
export function mapHookExternalContentSource(source) {
    return source === "gmail" ? "email" : "webhook";
}
export function isExternalHookSession(sessionKey) {
    return resolveHookExternalContentSource(sessionKey) !== undefined;
}

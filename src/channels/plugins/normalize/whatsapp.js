import { normalizeWhatsAppTarget } from "../../../whatsapp/normalize.js";
import { looksLikeHandleOrPhoneTarget, trimMessagingTarget } from "./shared.js";
export function normalizeWhatsAppMessagingTarget(raw) {
    const trimmed = trimMessagingTarget(raw);
    if (!trimmed) {
        return undefined;
    }
    return normalizeWhatsAppTarget(trimmed) ?? undefined;
}
export function normalizeWhatsAppAllowFromEntries(allowFrom) {
    return allowFrom
        .map((entry) => String(entry).trim())
        .filter((entry) => Boolean(entry))
        .map((entry) => (entry === "*" ? entry : normalizeWhatsAppTarget(entry)))
        .filter((entry) => Boolean(entry));
}
export function looksLikeWhatsAppTargetId(raw) {
    return looksLikeHandleOrPhoneTarget({
        raw,
        prefixPattern: /^whatsapp:/i,
    });
}

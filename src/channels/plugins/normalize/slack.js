import { parseSlackTarget } from "../../../slack/targets.js";
export function normalizeSlackMessagingTarget(raw) {
    const target = parseSlackTarget(raw, { defaultKind: "channel" });
    return target?.normalized;
}
export function looksLikeSlackTargetId(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return false;
    }
    if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) {
        return true;
    }
    if (/^(user|channel):/i.test(trimmed)) {
        return true;
    }
    if (/^slack:/i.test(trimmed)) {
        return true;
    }
    if (/^[@#]/.test(trimmed)) {
        return true;
    }
    return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}

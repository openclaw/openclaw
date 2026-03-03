function trimReason(reason) {
    return typeof reason === "string" ? reason.trim() : "";
}
export function normalizeHeartbeatWakeReason(reason) {
    const trimmed = trimReason(reason);
    return trimmed.length > 0 ? trimmed : "requested";
}
export function resolveHeartbeatReasonKind(reason) {
    const trimmed = trimReason(reason);
    if (trimmed === "retry") {
        return "retry";
    }
    if (trimmed === "interval") {
        return "interval";
    }
    if (trimmed === "manual") {
        return "manual";
    }
    if (trimmed === "exec-event") {
        return "exec-event";
    }
    if (trimmed === "wake") {
        return "wake";
    }
    if (trimmed.startsWith("cron:")) {
        return "cron";
    }
    if (trimmed.startsWith("hook:")) {
        return "hook";
    }
    return "other";
}
export function isHeartbeatEventDrivenReason(reason) {
    const kind = resolveHeartbeatReasonKind(reason);
    return kind === "exec-event" || kind === "cron" || kind === "wake" || kind === "hook";
}
export function isHeartbeatActionWakeReason(reason) {
    const kind = resolveHeartbeatReasonKind(reason);
    return kind === "manual" || kind === "exec-event" || kind === "hook";
}

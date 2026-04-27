import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
export function logLargePayload(params) {
    emitDiagnosticEvent({
        type: "payload.large",
        ...params,
    });
}
export function logRejectedLargePayload(params) {
    logLargePayload({
        action: "rejected",
        ...params,
    });
}
export function parseContentLengthHeader(raw) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
        return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

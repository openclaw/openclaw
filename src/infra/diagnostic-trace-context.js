import { randomBytes } from "node:crypto";
const TRACEPARENT_VERSION = "00";
const DEFAULT_TRACE_FLAGS = "01";
const MAX_TRACEPARENT_LENGTH = 128;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const TRACEPARENT_VERSION_RE = /^[0-9a-f]{2}$/;
function randomHex(bytes) {
    return randomBytes(bytes).toString("hex");
}
function isNonZeroHex(value) {
    return !/^0+$/.test(value);
}
function randomTraceId() {
    let traceId = randomHex(16);
    while (!isNonZeroHex(traceId)) {
        traceId = randomHex(16);
    }
    return traceId;
}
function randomSpanId() {
    let spanId = randomHex(8);
    while (!isNonZeroHex(spanId)) {
        spanId = randomHex(8);
    }
    return spanId;
}
export function isValidDiagnosticTraceId(value) {
    return typeof value === "string" && TRACE_ID_RE.test(value) && isNonZeroHex(value);
}
export function isValidDiagnosticSpanId(value) {
    return typeof value === "string" && SPAN_ID_RE.test(value) && isNonZeroHex(value);
}
export function isValidDiagnosticTraceFlags(value) {
    return typeof value === "string" && TRACE_FLAGS_RE.test(value);
}
function normalizeTraceId(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.toLowerCase();
    return isValidDiagnosticTraceId(normalized) ? normalized : undefined;
}
function normalizeSpanId(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.toLowerCase();
    return isValidDiagnosticSpanId(normalized) ? normalized : undefined;
}
function normalizeTraceFlags(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.toLowerCase();
    return isValidDiagnosticTraceFlags(normalized) ? normalized : undefined;
}
export function parseDiagnosticTraceparent(traceparent) {
    if (typeof traceparent !== "string" || traceparent.length > MAX_TRACEPARENT_LENGTH) {
        return undefined;
    }
    const parts = traceparent.trim().toLowerCase().split("-");
    if (!parts || parts.length < 4) {
        return undefined;
    }
    const [version, traceId, spanId, traceFlags] = parts;
    if (!TRACEPARENT_VERSION_RE.test(version) ||
        version === "ff" ||
        (version === TRACEPARENT_VERSION && parts.length !== 4)) {
        return undefined;
    }
    const normalizedTraceId = normalizeTraceId(traceId);
    const normalizedSpanId = normalizeSpanId(spanId);
    const normalizedTraceFlags = normalizeTraceFlags(traceFlags);
    if (!normalizedTraceId || !normalizedSpanId || !normalizedTraceFlags) {
        return undefined;
    }
    return {
        traceId: normalizedTraceId,
        spanId: normalizedSpanId,
        traceFlags: normalizedTraceFlags,
    };
}
export function formatDiagnosticTraceparent(context) {
    if (!context?.spanId) {
        return undefined;
    }
    const traceId = normalizeTraceId(context.traceId);
    const spanId = normalizeSpanId(context.spanId);
    const traceFlags = normalizeTraceFlags(context.traceFlags) ?? DEFAULT_TRACE_FLAGS;
    if (!traceId || !spanId) {
        return undefined;
    }
    return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${traceFlags}`;
}
export function createDiagnosticTraceContext(input = {}) {
    const parsed = parseDiagnosticTraceparent(input.traceparent);
    const traceId = normalizeTraceId(input.traceId) ?? parsed?.traceId ?? randomTraceId();
    const spanId = normalizeSpanId(input.spanId) ?? parsed?.spanId ?? randomSpanId();
    const parentSpanId = normalizeSpanId(input.parentSpanId);
    return {
        traceId,
        spanId,
        ...(parentSpanId && parentSpanId !== spanId ? { parentSpanId } : {}),
        traceFlags: normalizeTraceFlags(input.traceFlags) ?? parsed?.traceFlags ?? DEFAULT_TRACE_FLAGS,
    };
}
export function createChildDiagnosticTraceContext(parent, input = {}) {
    const parentSpanId = normalizeSpanId(input.parentSpanId) ?? normalizeSpanId(parent.spanId);
    return createDiagnosticTraceContext({
        traceId: parent.traceId,
        spanId: input.spanId,
        parentSpanId,
        traceFlags: input.traceFlags ?? parent.traceFlags,
    });
}
export function freezeDiagnosticTraceContext(context) {
    return Object.freeze({
        traceId: context.traceId,
        ...(context.spanId ? { spanId: context.spanId } : {}),
        ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        ...(context.traceFlags ? { traceFlags: context.traceFlags } : {}),
    });
}

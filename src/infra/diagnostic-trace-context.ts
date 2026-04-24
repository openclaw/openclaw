import { randomBytes } from "node:crypto";

const TRACEPARENT_VERSION = "00";
const DEFAULT_TRACE_FLAGS = "01";
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;

export type DiagnosticTraceContext = {
  /** W3C trace id, 32 lowercase hex chars. */
  traceId: string;
  /** Current span id, 16 lowercase hex chars. */
  spanId?: string;
  /** Parent span id, 16 lowercase hex chars. */
  parentSpanId?: string;
  /** W3C trace flags, 2 lowercase hex chars. Defaults to sampled. */
  traceFlags?: string;
};

export type DiagnosticTraceContextInput = Partial<DiagnosticTraceContext> & {
  traceparent?: string;
};

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function isNonZeroHex(value: string): boolean {
  return !/^0+$/.test(value);
}

export function isValidDiagnosticTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_RE.test(value) && isNonZeroHex(value);
}

export function isValidDiagnosticSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_RE.test(value) && isNonZeroHex(value);
}

export function isValidDiagnosticTraceFlags(value: unknown): value is string {
  return typeof value === "string" && TRACE_FLAGS_RE.test(value);
}

function normalizeTraceId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return isValidDiagnosticTraceId(normalized) ? normalized : undefined;
}

function normalizeSpanId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return isValidDiagnosticSpanId(normalized) ? normalized : undefined;
}

function normalizeTraceFlags(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return isValidDiagnosticTraceFlags(normalized) ? normalized : undefined;
}

export function parseDiagnosticTraceparent(
  traceparent: string | undefined,
): DiagnosticTraceContext | undefined {
  const parts = traceparent?.trim().toLowerCase().split("-");
  if (!parts || parts.length !== 4) {
    return undefined;
  }
  const [version, traceId, spanId, traceFlags] = parts;
  if (version !== TRACEPARENT_VERSION) {
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

export function formatDiagnosticTraceparent(
  context: DiagnosticTraceContext | undefined,
): string | undefined {
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

export function createDiagnosticTraceContext(
  input: DiagnosticTraceContextInput = {},
): DiagnosticTraceContext {
  const parsed = parseDiagnosticTraceparent(input.traceparent);
  const traceId = normalizeTraceId(input.traceId) ?? parsed?.traceId ?? randomHex(16);
  const spanId = normalizeSpanId(input.spanId) ?? parsed?.spanId ?? randomHex(8);
  const parentSpanId = normalizeSpanId(input.parentSpanId);
  return {
    traceId,
    spanId,
    ...(parentSpanId && parentSpanId !== spanId ? { parentSpanId } : {}),
    traceFlags: normalizeTraceFlags(input.traceFlags) ?? parsed?.traceFlags ?? DEFAULT_TRACE_FLAGS,
  };
}

export function createChildDiagnosticTraceContext(
  parent: DiagnosticTraceContext,
  input: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent"> = {},
): DiagnosticTraceContext {
  const parentSpanId = normalizeSpanId(input.parentSpanId) ?? normalizeSpanId(parent.spanId);
  return createDiagnosticTraceContext({
    traceId: parent.traceId,
    spanId: input.spanId,
    parentSpanId,
    traceFlags: input.traceFlags ?? parent.traceFlags,
  });
}

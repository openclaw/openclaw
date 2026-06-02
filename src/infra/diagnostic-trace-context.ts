import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const TRACEPARENT_VERSION = "00";
const DEFAULT_TRACE_FLAGS = "01";
const MAX_TRACEPARENT_LENGTH = 128;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const TRACEPARENT_VERSION_RE = /^[0-9a-f]{2}$/;
const DIAGNOSTIC_TRACE_SCOPE_STATE_KEY = Symbol.for("openclaw.diagnosticTraceScope.state.v1");

export type DiagnosticTraceContext = {
  /** W3C trace id, 32 lowercase hex chars. */
  readonly traceId: string;
  /** Current span id, 16 lowercase hex chars. */
  readonly spanId?: string;
  /** Parent span id, 16 lowercase hex chars. */
  readonly parentSpanId?: string;
  /** W3C trace flags, 2 lowercase hex chars. Defaults to sampled. */
  readonly traceFlags?: string;
};

type DiagnosticTraceContextInput = Partial<DiagnosticTraceContext> & {
  traceparent?: string;
};

type DiagnosticTraceScopeState = {
  marker: symbol;
  storage: AsyncLocalStorage<DiagnosticTraceContext>;
};

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function isNonZeroHex(value: string): boolean {
  return !/^0+$/.test(value);
}

function randomTraceId(): string {
  let traceId = randomHex(16);
  while (!isNonZeroHex(traceId)) {
    traceId = randomHex(16);
  }
  return traceId;
}

function randomSpanId(): string {
  let spanId = randomHex(8);
  while (!isNonZeroHex(spanId)) {
    spanId = randomHex(8);
  }
  return spanId;
}

function createDiagnosticTraceScopeState(): DiagnosticTraceScopeState {
  return {
    marker: DIAGNOSTIC_TRACE_SCOPE_STATE_KEY,
    storage: new AsyncLocalStorage<DiagnosticTraceContext>(),
  };
}

function isDiagnosticTraceScopeState(value: unknown): value is DiagnosticTraceScopeState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DiagnosticTraceScopeState>;
  return (
    candidate.marker === DIAGNOSTIC_TRACE_SCOPE_STATE_KEY &&
    candidate.storage instanceof AsyncLocalStorage
  );
}

function getDiagnosticTraceScopeState(): DiagnosticTraceScopeState {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DIAGNOSTIC_TRACE_SCOPE_STATE_KEY];
  if (isDiagnosticTraceScopeState(existing)) {
    return existing;
  }
  const state = createDiagnosticTraceScopeState();
  // Keep one AsyncLocalStorage instance across module reloads so nested callers
  // share the same active diagnostic scope within the process.
  Object.defineProperty(globalThis, DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

/** Validates a W3C trace id and rejects the all-zero sentinel value. */
export function isValidDiagnosticTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_RE.test(value) && isNonZeroHex(value);
}

/** Validates a W3C span id and rejects the all-zero sentinel value. */
export function isValidDiagnosticSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_RE.test(value) && isNonZeroHex(value);
}

/** Validates W3C trace flags as two lowercase hex characters. */
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

/** Parses bounded W3C traceparent header values into normalized diagnostic context. */
export function parseDiagnosticTraceparent(
  traceparent: string | undefined,
): DiagnosticTraceContext | undefined {
  if (typeof traceparent !== "string" || traceparent.length > MAX_TRACEPARENT_LENGTH) {
    return undefined;
  }
  const parts = traceparent.trim().toLowerCase().split("-");
  if (!parts || parts.length < 4) {
    return undefined;
  }
  const [version, traceId, spanId, traceFlags] = parts;
  if (
    !TRACEPARENT_VERSION_RE.test(version) ||
    version === "ff" ||
    (version === TRACEPARENT_VERSION && parts.length !== 4)
  ) {
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

/** Formats a diagnostic trace context as a W3C traceparent header value. */
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

/** Creates a normalized trace context from explicit fields, traceparent, or generated ids. */
export function createDiagnosticTraceContext(
  input: DiagnosticTraceContextInput = {},
): DiagnosticTraceContext {
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

/** Creates a child trace context that keeps the parent's trace id and current span as parent. */
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

/** Creates a child of the active diagnostic scope, or a fresh context when none is active. */
export function createDiagnosticTraceContextFromActiveScope(
  input: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent"> = {},
): DiagnosticTraceContext {
  const active = getActiveDiagnosticTraceContext();
  if (!active) {
    return createDiagnosticTraceContext(input);
  }
  return createChildDiagnosticTraceContext(active, input);
}

/** Freezes a compact defensive copy before storing or sharing trace context. */
export function freezeDiagnosticTraceContext(
  context: DiagnosticTraceContext,
): DiagnosticTraceContext {
  return Object.freeze({
    traceId: context.traceId,
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
    ...(context.traceFlags ? { traceFlags: context.traceFlags } : {}),
  });
}

/** Returns the AsyncLocalStorage-bound diagnostic trace context for this async flow. */
export function getActiveDiagnosticTraceContext(): DiagnosticTraceContext | undefined {
  return getDiagnosticTraceScopeState().storage.getStore();
}

/** Runs a callback with a frozen diagnostic trace context bound to async descendants. */
export function runWithDiagnosticTraceContext<T>(
  trace: DiagnosticTraceContext,
  callback: () => T,
): T {
  return getDiagnosticTraceScopeState().storage.run(freezeDiagnosticTraceContext(trace), callback);
}

/** Clears trace AsyncLocalStorage state between tests. */
export function resetDiagnosticTraceContextForTest(): void {
  getDiagnosticTraceScopeState().storage.disable();
}

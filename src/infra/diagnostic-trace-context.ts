// Creates and propagates lightweight W3C diagnostic trace contexts.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";

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
  storage: AsyncLocalStorage<DiagnosticTraceContext | undefined>;
};

function isNonZeroHex(value: string): boolean {
  return !/^0+$/.test(value);
}

function randomNonZeroHex(bytes: number): string {
  let value = randomBytes(bytes).toString("hex");
  while (!isNonZeroHex(value)) {
    value = randomBytes(bytes).toString("hex");
  }
  return value;
}

function createDiagnosticTraceScopeState(): DiagnosticTraceScopeState {
  return {
    marker: DIAGNOSTIC_TRACE_SCOPE_STATE_KEY,
    storage: new AsyncLocalStorage<DiagnosticTraceContext | undefined>(),
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
  Object.defineProperty(globalThis, DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

/** Returns whether a value is a non-zero W3C trace id. */
export function isValidDiagnosticTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_RE.test(value) && isNonZeroHex(value);
}

/** Returns whether a value is a non-zero W3C span id. */
export function isValidDiagnosticSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_RE.test(value) && isNonZeroHex(value);
}

/** Returns whether a value is a valid W3C trace-flags byte. */
export function isValidDiagnosticTraceFlags(value: unknown): value is string {
  return typeof value === "string" && TRACE_FLAGS_RE.test(value);
}

function normalizeTraceField(
  value: unknown,
  isValid: (value: unknown) => boolean,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return isValid(normalized) ? normalized : undefined;
}

/** Parses a W3C `traceparent` header into a normalized diagnostic trace context. */
export function parseDiagnosticTraceparent(
  traceparent: string | undefined,
): DiagnosticTraceContext | undefined {
  if (typeof traceparent !== "string" || traceparent.length > MAX_TRACEPARENT_LENGTH) {
    return undefined;
  }
  const parts = traceparent.trim().toLowerCase().split("-");
  if (parts.length < 4) {
    return undefined;
  }
  const [version, traceId, spanId, traceFlags] = parts;
  if (
    !TRACEPARENT_VERSION_RE.test(expectDefined(version, "diagnostic trace context version")) ||
    version === "ff" ||
    (version === TRACEPARENT_VERSION && parts.length !== 4)
  ) {
    return undefined;
  }
  const normalizedTraceId = normalizeTraceField(traceId, isValidDiagnosticTraceId);
  const normalizedSpanId = normalizeTraceField(spanId, isValidDiagnosticSpanId);
  const normalizedTraceFlags = normalizeTraceField(traceFlags, isValidDiagnosticTraceFlags);
  if (!normalizedTraceId || !normalizedSpanId || !normalizedTraceFlags) {
    return undefined;
  }
  return {
    traceId: normalizedTraceId,
    spanId: normalizedSpanId,
    traceFlags: normalizedTraceFlags,
  };
}

/** Formats a diagnostic trace context as a W3C `traceparent` header. */
export function formatDiagnosticTraceparent(
  context: DiagnosticTraceContext | undefined,
): string | undefined {
  if (!context?.spanId) {
    return undefined;
  }
  const traceId = normalizeTraceField(context.traceId, isValidDiagnosticTraceId);
  const spanId = normalizeTraceField(context.spanId, isValidDiagnosticSpanId);
  const traceFlags =
    normalizeTraceField(context.traceFlags, isValidDiagnosticTraceFlags) ?? DEFAULT_TRACE_FLAGS;
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
  const traceId =
    normalizeTraceField(input.traceId, isValidDiagnosticTraceId) ??
    parsed?.traceId ??
    randomNonZeroHex(16);
  const spanId =
    normalizeTraceField(input.spanId, isValidDiagnosticSpanId) ??
    parsed?.spanId ??
    randomNonZeroHex(8);
  const parentSpanId = normalizeTraceField(input.parentSpanId, isValidDiagnosticSpanId);
  return {
    traceId,
    spanId,
    ...(parentSpanId && parentSpanId !== spanId ? { parentSpanId } : {}),
    traceFlags:
      normalizeTraceField(input.traceFlags, isValidDiagnosticTraceFlags) ??
      parsed?.traceFlags ??
      DEFAULT_TRACE_FLAGS,
  };
}

/** Creates a child context that preserves the parent trace id and records the parent span id. */
export function createChildDiagnosticTraceContext(
  parent: DiagnosticTraceContext,
  input: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent"> = {},
): DiagnosticTraceContext {
  const parentSpanId =
    normalizeTraceField(input.parentSpanId, isValidDiagnosticSpanId) ??
    normalizeTraceField(parent.spanId, isValidDiagnosticSpanId);
  return createDiagnosticTraceContext({
    traceId: parent.traceId,
    spanId: input.spanId,
    parentSpanId,
    traceFlags: input.traceFlags ?? parent.traceFlags,
  });
}

/** Creates a child of the active trace scope, or a new root context when no scope is active. */
export function createDiagnosticTraceContextFromActiveScope(
  input: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent"> = {},
): DiagnosticTraceContext {
  const active = getActiveDiagnosticTraceContext();
  if (!active) {
    return createDiagnosticTraceContext(input);
  }
  return createChildDiagnosticTraceContext(active, input);
}

/** Returns an immutable defensive copy of a trace context. */
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

/** Returns the trace context bound to the current async scope. */
export function getActiveDiagnosticTraceContext(): DiagnosticTraceContext | undefined {
  return getDiagnosticTraceScopeState().storage.getStore();
}

/** Runs a callback with a frozen trace context, or explicitly without a trace. */
export function runWithDiagnosticTraceContext<T>(
  trace: DiagnosticTraceContext | undefined,
  callback: () => T,
): T {
  return getDiagnosticTraceScopeState().storage.run(
    trace === undefined ? undefined : freezeDiagnosticTraceContext(trace),
    callback,
  );
}

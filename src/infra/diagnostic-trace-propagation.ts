import {
  formatDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";

export type DiagnosticTracePropagationBridge<TEvent, TMetadata> = Readonly<{
  /** Selects events that need synchronous exporter preparation. */
  shouldPrepareEvent?: (event: TEvent) => boolean;
  /** Prepares exporter-owned state before an outbound caller can resolve it. */
  prepareEvent?: (event: TEvent, metadata: TMetadata) => void;
  /** Translates a diagnostic correlation context to an exporter-owned context. */
  resolveTraceContext: (traceContext: DiagnosticTraceContext) => DiagnosticTraceContext | undefined;
}>;

type RegisteredDiagnosticTracePropagationBridge = DiagnosticTracePropagationBridge<
  unknown,
  unknown
>;

type DiagnosticTracePropagationState = {
  marker: symbol;
  bridges: Set<RegisteredDiagnosticTracePropagationBridge>;
};

const DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY = Symbol.for(
  "openclaw.diagnosticTracePropagation.state.v1",
);

function isDiagnosticTracePropagationState(
  value: unknown,
): value is DiagnosticTracePropagationState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DiagnosticTracePropagationState>;
  return (
    candidate.marker === DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY && candidate.bridges instanceof Set
  );
}

function getDiagnosticTracePropagationState(): DiagnosticTracePropagationState {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY];
  if (isDiagnosticTracePropagationState(existing)) {
    return existing;
  }
  const state: DiagnosticTracePropagationState = {
    marker: DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY,
    bridges: new Set(),
  };
  Object.defineProperty(globalThis, DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

function activeDiagnosticTracePropagationBridge():
  | RegisteredDiagnosticTracePropagationBridge
  | undefined {
  let active: RegisteredDiagnosticTracePropagationBridge | undefined;
  for (const bridge of getDiagnosticTracePropagationState().bridges) {
    active = bridge;
  }
  return active;
}

export function registerDiagnosticTracePropagationBridge(
  bridge: DiagnosticTracePropagationBridge<never, never>,
): () => void {
  const state = getDiagnosticTracePropagationState();
  // The global registry crosses preloaded and plugin-owned SDK copies. Erase
  // event types only inside that registry; callers keep the exact typed seam.
  const registered = bridge as unknown as RegisteredDiagnosticTracePropagationBridge;
  state.bridges.add(registered);
  return () => {
    state.bridges.delete(registered);
  };
}

/** Whether an exporter-owned tracing consumer is active in this process. */
export function hasActiveDiagnosticTracePropagation(): boolean {
  return activeDiagnosticTracePropagationBridge() !== undefined;
}

export function shouldPrepareDiagnosticTracePropagation(event: unknown): boolean {
  const bridge = activeDiagnosticTracePropagationBridge();
  if (!bridge?.prepareEvent) {
    return false;
  }
  if (!bridge.shouldPrepareEvent) {
    return true;
  }
  try {
    return bridge.shouldPrepareEvent(event);
  } catch (error) {
    console.error(`[diagnostic-trace-propagation] prepare filter error: ${String(error)}`);
    return false;
  }
}

export function prepareDiagnosticTracePropagation(
  event: { type: string; seq: number },
  metadata: unknown,
): void {
  const bridge = activeDiagnosticTracePropagationBridge();
  if (!bridge?.prepareEvent) {
    return;
  }
  try {
    bridge.prepareEvent(event, metadata);
  } catch (error) {
    console.error(
      `[diagnostic-trace-propagation] prepare error type=${event.type} seq=${event.seq}: ${String(error)}`,
    );
  }
}

/** Formats the exporter-owned context when one is active, suppressing unresolved identities. */
export function formatPropagatedDiagnosticTraceparent(
  traceContext: DiagnosticTraceContext | undefined,
): string | undefined {
  if (!traceContext) {
    return undefined;
  }
  const bridge = activeDiagnosticTracePropagationBridge();
  if (!bridge) {
    return formatDiagnosticTraceparent(traceContext);
  }
  let propagated: DiagnosticTraceContext | undefined;
  try {
    propagated = bridge.resolveTraceContext(traceContext);
  } catch (error) {
    // An active exporter owns propagation. Falling back to diagnostic ids here
    // would name a parent span that the exporter never created.
    console.error(`[diagnostic-trace-propagation] resolve error: ${String(error)}`);
    return undefined;
  }
  return formatDiagnosticTraceparent(propagated);
}

export function resetDiagnosticTracePropagationForTest(): void {
  getDiagnosticTracePropagationState().bridges.clear();
}

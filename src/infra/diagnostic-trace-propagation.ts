import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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
  activeBridge: RegisteredDiagnosticTracePropagationBridge | undefined;
};

const DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY = Symbol.for(
  "openclaw.diagnosticTracePropagation.state.v1",
);

const tracePropagationState = resolveGlobalSingleton<DiagnosticTracePropagationState>(
  DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY,
  () => ({
    marker: DIAGNOSTIC_TRACE_PROPAGATION_STATE_KEY,
    bridges: new Set<RegisteredDiagnosticTracePropagationBridge>(),
    activeBridge: undefined,
  }),
);

/** Whether an exporter needs events prepared before their queued delivery. */
export function hasDiagnosticTracePropagationConsumer(): boolean {
  return tracePropagationState.activeBridge?.prepareEvent !== undefined;
}

export function registerDiagnosticTracePropagationBridge(
  bridge: DiagnosticTracePropagationBridge<never, never>,
): () => void {
  const state = tracePropagationState;
  // The global registry crosses preloaded and plugin-owned SDK copies. Erase
  // event types only inside that registry; callers keep the exact typed seam.
  const registered = bridge as unknown as RegisteredDiagnosticTracePropagationBridge;
  if (!state.bridges.has(registered)) {
    state.bridges.add(registered);
    state.activeBridge = registered;
  }
  return () => {
    if (!state.bridges.delete(registered) || state.activeBridge !== registered) {
      return;
    }
    state.activeBridge = undefined;
    for (const remaining of state.bridges) {
      state.activeBridge = remaining;
    }
  };
}

export function shouldPrepareDiagnosticTracePropagation(event: unknown): boolean {
  const bridge = tracePropagationState.activeBridge;
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
  const bridge = tracePropagationState.activeBridge;
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
  const bridge = tracePropagationState.activeBridge;
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
  tracePropagationState.bridges.clear();
  tracePropagationState.activeBridge = undefined;
}

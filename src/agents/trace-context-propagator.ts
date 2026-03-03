import type { StreamFn } from "@mariozechner/pi-agent-core";

// Shared symbol with diagnostics-otel extension for reading W3C Trace Context headers.
// The extension writes headers into a global Map keyed by sessionKey;
// this module reads them and injects into outgoing LLM requests.
const TRACE_CONTEXT_REGISTRY_KEY = Symbol.for("openclaw.diagnostics-otel.trace-headers");

type TraceHeaders = { traceparent: string; tracestate?: string };

function getTraceHeaders(sessionKey: string): TraceHeaders | undefined {
  const registry = (globalThis as { [TRACE_CONTEXT_REGISTRY_KEY]?: Map<string, TraceHeaders> })[
    TRACE_CONTEXT_REGISTRY_KEY
  ];
  return registry?.get(sessionKey);
}

/**
 * Wraps a StreamFn to inject W3C Trace Context headers (traceparent, tracestate)
 * into every outgoing LLM request. Headers are read from the global trace context
 * registry populated by the diagnostics-otel extension.
 *
 * If no trace context is available for the session, the inner stream function
 * is called unchanged.
 */
export function wrapStreamFnWithTraceContext(streamFn: StreamFn, sessionKey?: string): StreamFn {
  if (!sessionKey) {
    return streamFn;
  }

  return ((model, context, options) => {
    const traceHeaders = getTraceHeaders(sessionKey);
    if (!traceHeaders) {
      return streamFn(model, context, options);
    }

    const mergedOptions = {
      ...options,
      headers: {
        ...(options as { headers?: Record<string, string> } | undefined)?.headers,
        traceparent: traceHeaders.traceparent,
        ...(traceHeaders.tracestate ? { tracestate: traceHeaders.tracestate } : {}),
      },
    };
    return streamFn(model, context, mergedOptions);
  }) as StreamFn;
}

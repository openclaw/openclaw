import type { StreamFn } from "@mariozechner/pi-agent-core";

// Global trace context registry key (shared with diagnostics-otel plugin)
// The plugin stores pre-formatted W3C Trace Context headers here
const TRACE_CONTEXT_REGISTRY_KEY = Symbol.for("openclaw.diagnostics-otel.trace-headers");

type TraceHeaders = {
  traceparent: string;
  tracestate?: string;
};

function getTraceHeadersFromRegistry(sessionKey: string): TraceHeaders | undefined {
  const globalStore = globalThis as {
    [TRACE_CONTEXT_REGISTRY_KEY]?: Map<string, TraceHeaders>;
  };
  return globalStore[TRACE_CONTEXT_REGISTRY_KEY]?.get(sessionKey);
}

export function wrapStreamFnWithTraceContext(streamFn: StreamFn, sessionKey?: string): StreamFn {
  return (model, messages, options) => {
    if (!sessionKey) {
      return streamFn(model, messages, options);
    }

    const traceHeaders = getTraceHeadersFromRegistry(sessionKey);
    if (!traceHeaders) {
      return streamFn(model, messages, options);
    }

    const headersWithTrace = {
      ...options?.headers,
      traceparent: traceHeaders.traceparent,
      ...(traceHeaders.tracestate && { tracestate: traceHeaders.tracestate }),
    };

    return streamFn(model, messages, {
      ...options,
      headers: headersWithTrace,
    });
  };
}

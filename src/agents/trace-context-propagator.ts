import type { StreamFn } from "@mariozechner/pi-agent-core";
import { context, trace } from "@opentelemetry/api";

/**
 * Wraps a streamFn to inject W3C Trace Context headers into outgoing LLM requests.
 * This enables distributed tracing from OpenClaw -> vLLM (or other LLM providers).
 *
 * @param streamFn - The original stream function to wrap
 * @returns A wrapped stream function that injects trace context headers
 */
export function wrapStreamFnWithTraceContext(streamFn: StreamFn): StreamFn {
  return (model, messages, options) => {
    // Get the active OpenTelemetry span context
    const activeSpan = trace.getSpan(context.active());

    if (activeSpan) {
      const spanContext = activeSpan.spanContext();

      // Only propagate if the span context is valid and sampled
      if (spanContext.traceId && spanContext.spanId) {
        // Format W3C Trace Context traceparent header
        // Format: version-traceId-spanId-traceFlags
        // Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
        const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
          .toString(16)
          .padStart(2, "0")}`;

        // Inject trace context into request headers
        const headersWithTrace = {
          ...options?.headers,
          traceparent,
          // Also add tracestate if available (for vendor-specific context)
          ...(spanContext.traceState && {
            tracestate: spanContext.traceState.serialize(),
          }),
        };

        // Call original streamFn with injected headers
        return streamFn(model, messages, {
          ...options,
          headers: headersWithTrace,
        });
      }
    }

    // No active span or invalid context - call original streamFn without modification
    return streamFn(model, messages, options);
  };
}

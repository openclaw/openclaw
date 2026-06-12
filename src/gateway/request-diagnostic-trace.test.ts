import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createGatewayMessageDiagnosticTrace,
  createGatewayRequestDiagnosticTrace,
} from "./request-diagnostic-trace.js";

function requestWithTraceparent(traceparent?: string): IncomingMessage {
  return { headers: traceparent ? { traceparent } : {} } as IncomingMessage;
}

describe("gateway request diagnostic trace", () => {
  it("ignores inbound traceparent unless the caller trusts the boundary", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const requestTrace = createGatewayRequestDiagnosticTrace(
      requestWithTraceparent(`00-${traceId}-${spanId}-01`),
    );

    expect(requestTrace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(requestTrace.traceId).not.toBe(traceId);
    expect(requestTrace.parentSpanId).toBeUndefined();
  });

  it("creates a server child span from trusted inbound traceparent", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const requestTrace = createGatewayRequestDiagnosticTrace(
      requestWithTraceparent(`00-${traceId}-${spanId}-01`),
      { honorTraceparent: true },
    );

    expect(requestTrace.traceId).toBe(traceId);
    expect(requestTrace.parentSpanId).toBe(spanId);
    expect(requestTrace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(requestTrace.spanId).not.toBe(spanId);
  });

  it("creates message spans under the request span", () => {
    const requestTrace = createGatewayRequestDiagnosticTrace(requestWithTraceparent());
    const messageTrace = createGatewayMessageDiagnosticTrace(requestTrace);

    expect(messageTrace.traceId).toBe(requestTrace.traceId);
    expect(messageTrace.parentSpanId).toBe(requestTrace.spanId);
    expect(messageTrace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(messageTrace.spanId).not.toBe(requestTrace.spanId);
  });
});

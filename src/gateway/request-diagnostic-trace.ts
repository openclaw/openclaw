import type { IncomingMessage } from "node:http";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  parseDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value?.find((entry) => entry.trim().length > 0);
}

export function createGatewayRequestDiagnosticTrace(
  req: IncomingMessage,
  options: { honorTraceparent?: boolean } = {},
): DiagnosticTraceContext {
  const parentTrace = options.honorTraceparent
    ? parseDiagnosticTraceparent(firstHeaderValue(req.headers.traceparent))
    : undefined;
  return parentTrace
    ? createChildDiagnosticTraceContext(parentTrace)
    : createDiagnosticTraceContext();
}

export function createGatewayMessageDiagnosticTrace(
  requestTrace: DiagnosticTraceContext,
): DiagnosticTraceContext {
  return createChildDiagnosticTraceContext(requestTrace);
}

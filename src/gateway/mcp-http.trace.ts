import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  parseDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { JsonRpcRequest } from "./mcp-http.protocol.js";
import type { McpRequestContext } from "./mcp-http.request.js";

export type McpTraceOptions = {
  enabled: boolean;
  propagateTraceContext: boolean;
  captureBaggage: boolean;
};

export type McpTraceScope = McpTraceOptions & {
  sessionKey?: string;
  method: string;
  requestId?: string;
  toolName?: string;
  trace: DiagnosticTraceContext;
  startedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequestId(id: unknown): string | undefined {
  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }
  return undefined;
}

function extractMethodParams(message: JsonRpcRequest): Record<string, unknown> | undefined {
  return isRecord(message.params) ? message.params : undefined;
}

function extractMeta(message: JsonRpcRequest): Record<string, unknown> | undefined {
  const meta = extractMethodParams(message)?._meta;
  return isRecord(meta) ? meta : undefined;
}

function extractToolName(message: JsonRpcRequest): string | undefined {
  const name = extractMethodParams(message)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function extractRemoteTraceContext(
  message: JsonRpcRequest,
  options: Pick<McpTraceOptions, "propagateTraceContext">,
): DiagnosticTraceContext | undefined {
  if (!options.propagateTraceContext) {
    return undefined;
  }
  const traceparent = extractMeta(message)?.traceparent;
  return typeof traceparent === "string" ? parseDiagnosticTraceparent(traceparent) : undefined;
}

export function resolveMcpTraceOptions(cfg: OpenClawConfig): McpTraceOptions {
  const otel = cfg.diagnostics?.otel;
  const mcp = otel?.mcp;
  const enabled =
    cfg.diagnostics?.enabled !== false && otel?.enabled !== false && mcp?.enabled === true;
  const captureContentEnabled =
    otel?.captureContent === true ||
    (isRecord(otel?.captureContent) && otel.captureContent.enabled === true);
  return {
    enabled,
    propagateTraceContext: mcp?.propagateTraceContext !== false,
    captureBaggage: captureContentEnabled && mcp?.captureBaggage === true,
  };
}

export function startMcpTraceScope(params: {
  message: JsonRpcRequest;
  requestContext?: Pick<McpRequestContext, "sessionKey">;
  options: McpTraceOptions;
  now?: () => number;
}): McpTraceScope | undefined {
  if (!params.options.enabled) {
    return undefined;
  }
  const startedAt = params.now?.() ?? Date.now();
  const remoteParent = extractRemoteTraceContext(params.message, params.options);
  const trace = freezeDiagnosticTraceContext(
    remoteParent ? createChildDiagnosticTraceContext(remoteParent) : createDiagnosticTraceContext(),
  );
  const scope: McpTraceScope = {
    ...params.options,
    sessionKey: params.requestContext?.sessionKey,
    method: params.message.method,
    requestId: normalizeRequestId(params.message.id),
    toolName: params.message.method === "tools/call" ? extractToolName(params.message) : undefined,
    trace,
    startedAt,
  };
  emitMcpTraceEvent(scope, "mcp.request.started", startedAt);
  return scope;
}

export function completeMcpTraceScope(
  scope: McpTraceScope | undefined,
  response: object | null,
  now = Date.now,
): void {
  if (!scope) {
    return;
  }
  const endedAt = now();
  if (isJsonRpcToolError(response)) {
    emitMcpTraceEvent(scope, "mcp.request.error", endedAt, {
      errorCategory: "mcp_jsonrpc_error",
    });
    return;
  }
  emitMcpTraceEvent(scope, "mcp.request.completed", endedAt);
}

export function failMcpTraceScope(
  scope: McpTraceScope | undefined,
  error: unknown,
  now = Date.now,
): void {
  if (!scope) {
    return;
  }
  emitMcpTraceEvent(scope, "mcp.request.error", now(), {
    errorCategory: normalizeErrorCategory(error),
  });
}

function isJsonRpcToolError(response: object | null): boolean {
  return isRecord(response) && isRecord(response.result) && response.result.isError === true;
}

function normalizeErrorCategory(error: unknown): string {
  if (error instanceof Error && error.name.trim()) {
    return error.name.trim().slice(0, 120);
  }
  const message = formatErrorMessage(error).trim();
  return message ? message.slice(0, 120) : "Error";
}

function emitMcpTraceEvent(
  scope: McpTraceScope,
  type: "mcp.request.started" | "mcp.request.completed" | "mcp.request.error",
  ts: number,
  extra: { errorCategory?: string } = {},
): void {
  const base = {
    trace: scope.trace,
    sessionKey: scope.sessionKey,
    method: scope.method,
    requestId: scope.requestId,
    toolName: scope.toolName,
    transport: "streamable-http" as const,
  };
  const durationMs = Math.max(0, ts - scope.startedAt);
  const event: DiagnosticEventInput =
    type === "mcp.request.started"
      ? { ...base, type: "mcp.request.started" }
      : type === "mcp.request.completed"
        ? { ...base, type: "mcp.request.completed", durationMs }
        : {
            ...base,
            type: "mcp.request.error",
            durationMs,
            errorCategory: extra.errorCategory ?? "Error",
          };
  emitTrustedDiagnosticEvent(event);
}

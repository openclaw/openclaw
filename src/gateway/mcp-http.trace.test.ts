import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import { formatDiagnosticTraceparent } from "../infra/diagnostic-trace-context.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { jsonRpcResult, type JsonRpcRequest } from "./mcp-http.protocol.js";
import {
  completeMcpTraceScope,
  resolveMcpTraceOptions,
  startMcpTraceScope,
} from "./mcp-http.trace.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

beforeEach(() => {
  resetDiagnosticEventsForTest();
});

afterEach(() => {
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

const waitForDiagnosticDrain = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe("MCP trace context canary", () => {
  it("is disabled by default and opt-in via diagnostics.otel.mcp.enabled", () => {
    expect(resolveMcpTraceOptions({}).enabled).toBe(false);
    expect(
      resolveMcpTraceOptions({ diagnostics: { otel: { mcp: { enabled: true } } } }).enabled,
    ).toBe(true);
    expect(
      resolveMcpTraceOptions({
        diagnostics: { enabled: false, otel: { mcp: { enabled: true } } },
      }).enabled,
    ).toBe(false);
    expect(
      resolveMcpTraceOptions({
        diagnostics: { otel: { mcp: { enabled: true, captureBaggage: true } } },
      }).captureBaggage,
    ).toBe(false);
    expect(
      resolveMcpTraceOptions({
        diagnostics: {
          otel: { captureContent: { enabled: true }, mcp: { enabled: true, captureBaggage: true } },
        },
      }).captureBaggage,
    ).toBe(true);
  });

  it("extracts params._meta.traceparent as the remote parent without mutating _meta", async () => {
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "message",
        arguments: { text: "hello" },
        _meta: { traceparent: TRACEPARENT, keep: "caller-value" },
      },
    };
    const events: Array<{
      type: string;
      trace?: { traceId?: string; parentSpanId?: string };
      transport?: string;
    }> = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("mcp.")) {
        events.push(event);
      }
    });

    const scope = startMcpTraceScope({
      message,
      requestContext: { sessionKey: "agent:main:main" },
      options: { enabled: true, propagateTraceContext: true, captureBaggage: false },
      now: () => 100,
    });
    completeMcpTraceScope(scope, jsonRpcResult(7, { ok: true }), () => 125);
    await waitForDiagnosticDrain();
    stop();

    expect((message.params as Record<string, unknown>)._meta).toEqual({
      traceparent: TRACEPARENT,
      keep: "caller-value",
    });
    expect(scope?.trace.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(scope?.trace.parentSpanId).toBe("00f067aa0ba902b7");
    expect(formatDiagnosticTraceparent(scope?.trace)).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
    );
    expect(events.map((event) => event.type)).toEqual([
      "mcp.request.started",
      "mcp.request.completed",
    ]);
    expect(events.map((event) => event.transport)).toEqual(["streamable-http", "streamable-http"]);
  });

  it("emits an MCP error event for JSON-RPC tool error results", async () => {
    const events: Array<{ type: string; errorCategory?: string; durationMs?: number }> = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("mcp.")) {
        events.push(event as (typeof events)[number]);
      }
    });
    const scope = startMcpTraceScope({
      message: { jsonrpc: "2.0", id: "x", method: "tools/call", params: { name: "missing" } },
      options: { enabled: true, propagateTraceContext: true, captureBaggage: false },
      now: () => 10,
    });

    completeMcpTraceScope(scope, jsonRpcResult("x", { isError: true }), () => 42);
    await waitForDiagnosticDrain();
    stop();

    expect(events).toMatchObject([
      { type: "mcp.request.started" },
      { type: "mcp.request.error", durationMs: 32, errorCategory: "mcp_jsonrpc_error" },
    ]);
  });

  it("leaves tool-call behavior and caller _meta unchanged when disabled", async () => {
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: {
        name: "probe",
        arguments: { value: 1 },
        _meta: { traceparent: TRACEPARENT, keep: "caller-value" },
      },
    };
    const events: string[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("mcp.")) {
        events.push(event.type);
      }
    });

    const response = await handleMcpJsonRpc({
      message,
      tools: [
        {
          name: "probe",
          label: "Probe",
          description: "probe tool",
          parameters: { type: "object", properties: {} },
          execute: async (_toolCallId, params) => ({
            content: [{ type: "text", text: JSON.stringify(params) }],
            details: {},
          }),
        },
      ],
      toolSchema: [],
      mcpTrace: { enabled: false, propagateTraceContext: true, captureBaggage: false },
    });
    await waitForDiagnosticDrain();
    stop();

    expect(response).toEqual(
      jsonRpcResult("call-1", {
        content: [{ type: "text", text: '{"value":1}' }],
        isError: false,
      }),
    );
    expect((message.params as Record<string, unknown>)._meta).toEqual({
      traceparent: TRACEPARENT,
      keep: "caller-value",
    });
    expect(events).toEqual([]);
  });
});

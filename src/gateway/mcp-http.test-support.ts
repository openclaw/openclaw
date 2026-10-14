import { expect } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

export type MockGatewayTool = {
  name: string;
  label: string;
  description: string;
  parameters: AnyAgentTool["parameters"] | Record<string, unknown>;
  prepareBeforeToolCallParams?: (...args: unknown[]) => unknown;
  finalizeBeforeToolCallParams?: (...args: unknown[]) => unknown;
  execute: (...args: unknown[]) => Promise<{
    content: unknown[];
    details?: unknown;
  }>;
};

export type MockGatewayScopedTools = {
  agentId: string;
  workspaceDir?: string;
  tools: MockGatewayTool[];
};

export type McpToolResultPayload = {
  result?: {
    tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
  };
};

export async function startLoopbackServerForTest() {
  await ensureMcpLoopbackServer(0);
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("expected active MCP loopback runtime");
  }
  return { port: runtime.port, runtime };
}

export async function sendRaw(params: {
  port: number;
  token?: string;
  method?: "GET" | "POST" | "DELETE" | "PUT";
  headers?: Record<string, string>;
  body?: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/mcp`, {
    method: params.method ?? "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...params.headers,
    },
    body: params.body,
  });
}

export async function readMcpPayload(response: Response): Promise<McpToolResultPayload> {
  return (await response.json()) as McpToolResultPayload;
}

export async function readOkMcpPayload(response: Response) {
  const payload = await readMcpPayload(response);
  expect(response.status).toBe(200);
  return payload;
}

export async function sendLoopbackToolCall(params: {
  token?: string;
  name: string;
  args?: Record<string, unknown>;
  headers?: Record<string, string>;
}) {
  return sendRaw({
    port: getActiveMcpLoopbackRuntime()?.port ?? 0,
    token: params.token,
    headers: jsonHeaders(params.headers),
    body: mcpToolCallBody(params.name, params.args),
  });
}

export function jsonHeaders(headers: Record<string, string> = {}) {
  return { "content-type": "application/json", ...headers };
}

export function mcpToolCallBody(name: string, args: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify(mcpToolCallMessage(name, args, id));
}

export function mcpToolCallMessage(name: string, args: Record<string, unknown> = {}, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  } as const;
}

// Pure JSON-schema builders shared with mcp-http.test.ts, split out to keep that
// grandfathered test file within its line cap.
export function objectSchema(properties: Record<string, unknown>, required?: string[]) {
  return {
    type: "object",
    properties,
    ...(required ? { required } : {}),
  };
}

export function angleSchema(property: unknown, required: string[] = []) {
  return objectSchema({ angle: property }, required);
}

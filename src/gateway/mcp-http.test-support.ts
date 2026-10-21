import { afterAll, beforeAll, expect, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { activateMcpLoopbackClientGrantCapture } from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

export type MockGatewayTool = Pick<AnyAgentTool, "name" | "label" | "description"> & {
  parameters: AnyAgentTool["parameters"] | Record<string, unknown>;
  prepareBeforeToolCallParams?: (...args: unknown[]) => unknown;
  finalizeBeforeToolCallParams?: (...args: unknown[]) => unknown;
  execute: (...args: unknown[]) => Promise<{ content: unknown[]; details?: unknown }>;
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

export function scopedToolFixture<T>(tools: T[], workspaceDir: string) {
  return { agentId: "main", workspaceDir, captureFinalCronCreatorTools: undefined, tools };
}

export function captureGrant(token: string, captureKey: string, runtimeOwnerToken: string) {
  const capture = { token, captureKey, runtimeOwnerToken };
  expect(activateMcpLoopbackClientGrantCapture(capture)).toBeTruthy();
  return capture;
}

export async function startLoopbackServerForTest() {
  await ensureMcpLoopbackServer(0);
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("expected active MCP loopback runtime");
  }
  return { port: runtime.port, runtime };
}

export function useLoopbackServerForTest() {
  let runtime: Awaited<ReturnType<typeof startLoopbackServerForTest>>["runtime"];
  beforeAll(async () => {
    ({ runtime } = await startLoopbackServerForTest());
  });
  afterAll(async () => {
    await closeMcpLoopbackServer();
    vi.restoreAllMocks();
  });
  return () => runtime;
}

export async function sendRaw(params: {
  port: number;
  token?: string;
  method?: "GET" | "POST" | "DELETE" | "PUT";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/mcp`, {
    method: params.method ?? "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...params.headers,
    },
    body: params.body,
    signal: params.signal,
  });
}

export const readMcpPayload = async (response: Response): Promise<McpToolResultPayload> =>
  (await response.json()) as McpToolResultPayload;

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

export const mcpToolCallBody = (name: string, args: Record<string, unknown> = {}, id = 1) =>
  JSON.stringify(mcpToolCallMessage(name, args, id));

export function mcpToolCallMessage(name: string, args: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } as const;
}

export function expectMcpToolNames(payload: McpToolResultPayload, expected: string[]) {
  const names = (payload.result?.tools ?? []).map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(expected));
}

export function expectMcpResultText(
  payload: McpToolResultPayload,
  text: string,
  isError?: boolean,
) {
  if (isError === undefined) {
    expect(payload.result?.isError).not.toBe(true);
  } else {
    expect(payload.result?.isError).toBe(isError);
  }
  expect(payload.result?.content?.[0]?.text).toBe(text);
}

export function objectSchema(properties: Record<string, unknown>, required?: string[]) {
  return { type: "object", properties, ...(required ? { required } : {}) };
}

export const angleSchema = (property: unknown, required: string[] = []) =>
  objectSchema({ angle: property }, required);

export function makeMockTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return {
    name: "mockplugin_tool",
    label: "Mock tool",
    description: "mock tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

export const makeMessageTool = (overrides: Partial<MockGatewayTool> = {}): MockGatewayTool =>
  makeMockTool({ name: "message", description: "send a message", ...overrides });

export const makeCronTool = (overrides: Partial<MockGatewayTool> = {}): MockGatewayTool =>
  makeMockTool({ name: "cron", description: "manage schedules", ...overrides });

export const mcpToolsListBody = (id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });

export function buildMockMcpToolSchema(tools: MockGatewayTool[]) {
  return buildMcpToolSchema(tools as unknown as Parameters<typeof buildMcpToolSchema>[0]);
}

type McpToolCacheParams = Parameters<McpLoopbackToolCache["resolve"]>[0];

export function createMcpToolCacheResolver({
  cfg = {},
  ...baseContext
}: Partial<McpToolCacheParams["context"] & Pick<McpToolCacheParams, "cfg">> = {}) {
  const cache = new McpLoopbackToolCache();
  return (context: Partial<McpToolCacheParams["context"]> = {}) =>
    cache.resolve({
      cfg,
      context: {
        sessionKey: "agent:main:direct:test",
        senderIsOwner: true,
        ...baseContext,
        ...context,
      },
    });
}

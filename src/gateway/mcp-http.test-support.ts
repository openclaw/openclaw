import { expect, it, vi, type Mock } from "vitest";
import type { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { buildCliMcpGrantContext } from "../agents/cli-runner/mcp-grant-context.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { mintAttachGrant, type McpLoopbackRequestContext } from "./mcp-grant-store.js";
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

export function makeMockTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return {
    name: "mockplugin_tool",
    label: "Mock tool",
    description: "mock tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
    }),
    ...overrides,
  };
}

export function makeMessageTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return makeMockTool({
    name: "message",
    description: "send a message",
    ...overrides,
  });
}

export function makeCronTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return makeMockTool({
    name: "cron",
    description: "manage schedules",
    ...overrides,
  });
}

export function registerMcpRequesterPolicyTests({
  createCliGrant,
  mockScopedTools,
  runBeforeToolCallHookMock,
  getBeforeToolCallHookInput,
}: {
  createCliGrant: (
    runId: string,
    options: { context: McpLoopbackRequestContext },
  ) => Promise<{ scope: { token: string; headers: Record<string, string> } }>;
  mockScopedTools: (tools: MockGatewayTool[]) => void;
  runBeforeToolCallHookMock: Mock<typeof runBeforeToolCallHook>;
  getBeforeToolCallHookInput: (index: number) => Parameters<typeof runBeforeToolCallHook>[0];
}) {
  it.each(["owner", "guest", "missing", "attach"] as const)(
    "applies sender-aware tool policy using only captured CLI requester facts (%s)",
    async (identity) => {
      await startLoopbackServerForTest();
      const execute = vi.fn(async () => ({ content: [{ type: "text", text: "sent" }] }));
      mockScopedTools([makeMessageTool({ execute })]);
      runBeforeToolCallHookMock.mockImplementation(async (args) => {
        if (args.ctx?.requester?.senderIsOwner !== true) {
          return {
            blocked: true,
            kind: "veto",
            reason: "Requester is not a proven owner",
            params: args.params,
          };
        }
        return { blocked: false, params: args.params };
      });
      const context = buildCliMcpGrantContext({
        run: {
          sessionId: "requester-session",
          sessionKey: "agent:main:requester",
          sessionFile: "/tmp/requester-session",
          workspaceDir: "/tmp/requester-workspace",
          provider: "fixture-cli",
          prompt: "Synthetic requester policy check",
          timeoutMs: 1_000,
          runId: "run-requester",
          ...(identity === "owner" || identity === "guest"
            ? {
                messageProvider: "discord",
                agentAccountId: "bound-account",
                senderId: "bound-sender",
                senderIsOwner: identity === "owner",
              }
            : {}),
        },
        config: {},
        requireExplicitMessageTarget: false,
        agentId: "main",
        modelProvider: "fixture-provider",
        modelId: "fixture-model",
      });
      const scope =
        identity === "attach"
          ? {
              token: mintAttachGrant({ sessionKey: "agent:main:requester", agentId: "main" }).token,
            }
          : (await createCliGrant("run-requester", { context })).scope;
      const result = await readOkMcpPayload(
        await sendLoopbackToolCall({
          ...scope,
          name: "message",
          headers: {
            ...("headers" in scope ? scope.headers : {}),
            "x-openclaw-message-channel": "telegram",
            "x-openclaw-account-id": "forged-account",
            "x-openclaw-sender-id": "forged-owner",
            "x-openclaw-sender-is-owner": "true",
          },
        }),
      );
      expect(result.result?.isError === true).toBe(identity !== "owner");
      expect(execute).toHaveBeenCalledTimes(identity === "owner" ? 1 : 0);
      if (identity === "owner" || identity === "guest") {
        expect(getBeforeToolCallHookInput(0).ctx?.requester).toEqual({
          channel: "discord",
          accountId: "bound-account",
          senderId: "bound-sender",
          senderIsOwner: identity === "owner",
        });
      } else {
        expect(getBeforeToolCallHookInput(0).ctx?.requester).toBeUndefined();
      }
    },
  );
}

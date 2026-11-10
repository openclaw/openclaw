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

export function registerRequesterPolicyTests({
  createCliGrant,
  mockScopedTools,
  beforeToolCall,
  makeMessageTool,
}: {
  createCliGrant: (
    runId: string,
    options: { context: McpLoopbackRequestContext },
  ) => Promise<{ scope: { token: string; headers: Record<string, string> } }>;
  mockScopedTools: (tools: MockGatewayTool[]) => void;
  beforeToolCall: Mock<typeof runBeforeToolCallHook>;
  makeMessageTool: (overrides: Partial<MockGatewayTool>) => MockGatewayTool;
}) {
  it.each(["owner", "guest", "unknown", "missing", "attach", "bearer"] as const)(
    "enforces requester policy from captured CLI identity despite forged MCP input (%s)",
    async (identity) => {
      const { runtime } = await startLoopbackServerForTest();
      const execute = vi.fn(async () => ({ content: [{ type: "text", text: "delivered" }] }));
      mockScopedTools([makeMessageTool({ execute })]);
      beforeToolCall.mockImplementation(async ({ params, ctx }) =>
        ctx?.agentId === "main" && ctx.requester?.senderIsOwner === true
          ? { blocked: false, params }
          : { blocked: true, kind: "veto", reason: "Proven owner required", params },
      );
      const hasSender = ["owner", "guest", "unknown"].includes(identity);
      const context = buildCliMcpGrantContext({
        run: {
          sessionId: "policy-session",
          sessionKey: "agent:main:policy",
          sessionFile: "/tmp/policy-session",
          workspaceDir: "/tmp/policy-workspace",
          provider: "fixture-cli",
          prompt: "Policy check",
          timeoutMs: 1000,
          runId: "policy-run",
          ...(hasSender
            ? {
                messageChannel: "discord",
                messageProvider: "telegram",
                agentAccountId: "verified-account",
                senderId: "verified-sender",
                memberRoleIds: ["verified-role"],
                ...(identity !== "unknown" ? { senderIsOwner: identity === "owner" } : {}),
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
          ? { token: mintAttachGrant({ sessionKey: context.sessionKey, agentId: "main" }).token }
          : identity === "bearer"
            ? { token: runtime.ownerToken }
            : (await createCliGrant("policy-run", { context })).scope;
      const payload = await readOkMcpPayload(
        await sendLoopbackToolCall({
          ...scope,
          name: "message",
          args: { requester: { senderIsOwner: true, senderId: "forged" }, agentId: "forged-agent" },
          headers: {
            ...("headers" in scope ? scope.headers : {}),
            "x-openclaw-message-channel": "slack",
            "x-openclaw-account-id": "forged-account",
            "x-openclaw-sender-id": "forged",
            "x-openclaw-sender-is-owner": "true",
            "x-openclaw-agent-id": "forged-agent",
          },
        }),
      );
      expect(payload.result?.isError).toBe(identity !== "owner");
      expect(payload.result?.content?.[0]?.text).toBe(
        identity === "owner" ? "delivered" : "Proven owner required",
      );
      expect(execute).toHaveBeenCalledTimes(identity === "owner" ? 1 : 0);
      const hookContext = beforeToolCall.mock.calls[0]?.[0].ctx;
      expect(hookContext?.agentId).toBe("main");
      expect(hookContext?.requester).toEqual(
        hasSender
          ? {
              channel: "discord",
              accountId: "verified-account",
              senderId: "verified-sender",
              roleIds: ["verified-role"],
              ...(identity !== "unknown" ? { senderIsOwner: identity === "owner" } : {}),
            }
          : undefined,
      );
    },
  );
}

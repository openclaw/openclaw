import { afterAll, beforeAll, expect, it, vi, type Mock } from "vitest";
import type { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { buildCliMcpGrantContext } from "../agents/cli-runner/mcp-grant-context.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  type McpLoopbackRequestContext,
} from "./mcp-grant-store.js";
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
    instructions?: string;
    tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
    content?: Array<{ text?: string; [key: string]: unknown }>;
    isError?: boolean;
  };
};

export function setMinimalCliPrepareDeps(
  setDeps: typeof import("../agents/cli-runner/prepare.test-support.js").setCliRunnerPrepareTestDeps,
) {
  setDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    loadManifestModelCatalog: () => [],
  });
}

export async function connectPreparedCliTurn(context: PreparedCliRunContext, signal: AbortSignal) {
  const { createCliRunCurrentAssertion } = await import("../agents/cli-runner/execution-target.js");
  const runtime = getActiveMcpLoopbackRuntime();
  const token = context.preparedBackend.env?.OPENCLAW_MCP_TOKEN;
  if (!runtime || !token) {
    throw new Error("Expected prepared CLI grant and MCP loopback runtime");
  }
  const captureKey = `capture-${context.params.runId}`;
  context.preparedBackend.mcpClientGrantCapture?.activate(
    captureKey,
    createCliRunCurrentAssertion(context.params),
  );
  return {
    token,
    rpc: async (method: string, params?: Record<string, unknown>) => {
      const response = await sendRaw({
        port: runtime.port,
        token,
        signal,
        headers: jsonHeaders({ "x-openclaw-cli-capture-key": captureKey }),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      });
      return { status: response.status, body: await readMcpPayload(response) };
    },
  };
}

export function scopedToolFixture<T>(tools: T[], workspaceDir: string) {
  return { agentId: "main", workspaceDir, captureFinalCronCreatorTools: undefined, tools };
}

export function captureGrant(token: string, captureKey: string, runtimeOwnerToken: string) {
  const capture = { token, captureKey, runtimeOwnerToken };
  expect(activateMcpLoopbackClientGrantCapture(capture)).toBeTruthy();
  return capture;
}

export async function startLoopbackServerForTest() {
  await ensureMcpLoopbackServer();
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

export function registerRequesterPolicyTests({
  createCliGrant,
  mockScopedTools,
  beforeToolCall,
}: {
  createCliGrant: (
    runId: string,
    options: { context: McpLoopbackRequestContext },
  ) => Promise<{ scope: { token: string; headers: Record<string, string> } }>;
  mockScopedTools: (tools: MockGatewayTool[]) => void;
  beforeToolCall: Mock<typeof runBeforeToolCallHook>;
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

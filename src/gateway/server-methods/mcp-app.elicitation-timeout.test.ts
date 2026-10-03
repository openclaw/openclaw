import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSessionMcpRuntime } from "../../agents/agent-bundle-mcp-runtime.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import {
  createMcpClientElicitationHandler,
  runWithMcpElicitationHandler,
} from "../../agents/mcp-client-elicitation.js";
import type { McpAppViewLease } from "../../agents/mcp-ui-resource.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { mcpAppHandlers } from "./mcp-app.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({ transport: vi.fn(), view: vi.fn(), question: vi.fn() }));
vi.mock("../../agents/mcp-transport.js", () => ({ resolveMcpTransport: mocks.transport }));
vi.mock("../../agents/embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: () => ({
    mcpServers: { demo: { command: "fixture" } },
    diagnostics: [],
    prepareDataDirsByServer: {},
  }),
}));
vi.mock("../../agents/mcp-ui-resource.js", () => ({
  getMcpAppViewLease: mocks.view,
  getMcpAppViewLeaseForSession: mocks.view,
  acquireMcpAppViewRequest: () => () => {},
}));
vi.mock("../../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: async () => false,
}));
vi.mock("./session-scoped-read.js", () => ({ retainSessionScopedRead: () => undefined }));
vi.mock("../mcp-app-reconstruction.js", () => ({ restoreMcpAppView: vi.fn() }));
vi.mock("../mcp-app-standalone.js", () => ({ createMcpAppStandaloneTicket: vi.fn() }));
vi.mock("../server-methods.js", () => ({
  handleGatewayRequest: async (options: GatewayRequestHandlerOptions) => {
    options.respond(
      true,
      await mocks.question(options.req.method, options.req.params, options.signal),
    );
  },
}));

const requestTimeoutMs = 60_000;
const cfg = { mcp: { apps: { enabled: true } } };
const answer: { status: "answered"; answers: { answers: Record<string, string[]> } } = {
  status: "answered",
  answers: { answers: { choice: ["Blue"] } },
};
const resultSchema = z.object({
  action: z.string(),
  content: z.record(z.string(), z.unknown()).optional(),
});
let runtime: ReturnType<typeof createSessionMcpRuntime>;
let server: Server;
let view: McpAppViewLease;
let questionStarted: ReturnType<typeof createDeferred<void>>;
let questionAnswer: ReturnType<typeof createDeferred<typeof answer>>;
let toolStarted: ReturnType<typeof createDeferred<void>>;
let toolCalls: number;

beforeEach(async () => {
  vi.useFakeTimers();
  questionStarted = createDeferred();
  questionAnswer = createDeferred<typeof answer>();
  toolStarted = createDeferred();
  toolCalls = 0;
  mocks.question.mockReset().mockImplementation(async (method, params, signal) => {
    if (method === "question.request") {
      return { id: params.id };
    }
    if (method === "question.waitAnswer") {
      questionStarted.resolve();
      return racePromiseWithAbortSignal(questionAnswer.promise, signal);
    }
    return {};
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = new Server(
    { name: "demo", version: "1" },
    {
      capabilities: {
        tools: {},
        experimental: { "openai/settings": { readTool: "read", updateTool: "update" } },
      },
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "pick", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    toolCalls += 1;
    toolStarted.resolve();
    const result = await server.request(
      {
        method: "elicitation/create",
        params: {
          message: "Choose a color",
          requestedSchema: {
            type: "object",
            properties: { choice: { type: "string", enum: ["Blue", "Red"] } },
            required: ["choice"],
          },
        },
      },
      resultSchema,
      { timeout: 600_000 },
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  await server.connect(serverTransport);
  mocks.transport.mockReturnValue({
    transport: clientTransport,
    description: "in-memory MCP server",
    transportType: "stdio",
    connectionTimeoutMs: requestTimeoutMs,
    requestTimeoutMs,
    supportsParallelToolCalls: true,
  });
  runtime = createSessionMcpRuntime({
    sessionId: "elicitation",
    sessionKey: "agent:main:main",
    workspaceDir: "/workspace",
    cfg,
  });
  await runtime.getCatalog();
  view = {
    viewId: "cv_timeout",
    runtime,
    sessionId: runtime.sessionId,
    agentId: "main",
    serverName: "demo",
    toolName: "pick",
    uiResourceUri: "ui://demo/app",
    html: "",
    byteSize: 0,
    toolInput: {},
    toolResult: { content: [] },
    allowedAppToolNames: new Set(["pick"]),
    expiresAtMs: Date.now() + 600_000,
    requestWindowStartedAtMs: Date.now(),
    requestCount: 0,
    toolCallCount: 0,
    activeRequests: 0,
    prepareToolCall: async () => {},
  };
  mocks.view.mockReturnValue(view);
});

afterEach(async () => {
  await runtime?.dispose();
  await runtime?.joinCleanup?.();
  await server?.close();
  vi.useRealTimers();
});

function invoke() {
  const respond = vi.fn();
  const pending = mcpAppHandlers["mcp.app.callTool"]!({
    respond,
    params: { sessionKey: "agent:main:main", viewId: view.viewId, toolName: "pick" },
    client: { connect: { scopes: ["operator.write"] } },
    context: { getRuntimeConfig: () => cfg },
  } as unknown as GatewayRequestHandlerOptions);
  return { respond, pending };
}

describe("MCP extension contracts", () => {
  it("does not advertise settings from the unshipped experimental placement", async () => {
    expect((await runtime.getCatalog()).servers.demo?.settings).toBeUndefined();
  });

  it("ignores the unshipped thumbnail alias in a registered app form", async () => {
    server.setRequestHandler(CallToolRequestSchema, async () => {
      const result = await server.request(
        {
          method: "openai/elicitation/create",
          params: {
            message: "Choose a color",
            requestedSchema: {
              type: "object",
              properties: {
                choice: {
                  type: "string",
                  oneOf: [
                    {
                      const: "Blue",
                      title: "Blue",
                      "x-openai-preview": { src: "https://example.com/blue.png" },
                    },
                    {
                      const: "Red",
                      title: "Red",
                      "x-openai-thumbnail": { src: "https://example.com/red.png" },
                    },
                  ],
                },
              },
              required: ["choice"],
            },
          },
        },
        resultSchema,
      );
      return { content: [], structuredContent: result };
    });
    const call = invoke();
    await questionStarted.promise;
    const request = mocks.question.mock.calls.find(([method]) => method === "question.request")![1];
    questionAnswer.resolve(answer);
    await call.pending;
    expect(request.questions[0].options).toEqual([
      { label: "Blue", value: "Blue" },
      { label: "Red", value: "Red", thumbnail: "https://example.com/red.png" },
    ]);
    expect(call.respond).toHaveBeenCalledWith(true, {
      content: [],
      structuredContent: { action: "accept", content: { choice: "Blue" } },
    });
  });
});

describe("MCP tool human-input timeouts", () => {
  it("dispatches the registered app call after approval and keeps its human question alive", async () => {
    const approvalStarted = createDeferred();
    const approval = createDeferred();
    view.prepareToolCall = async () => {
      approvalStarted.resolve();
      await approval.promise;
    };
    const call = invoke();
    await approvalStarted.promise;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(toolCalls).toBe(0);
    expect(call.respond).not.toHaveBeenCalled();
    approval.resolve();
    await questionStarted.promise;
    expect
      .soft(mocks.question.mock.calls.find(([method]) => method === "question.request")![1])
      .toMatchObject({ timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(500_000);
    expect(call.respond).not.toHaveBeenCalled();
    questionAnswer.resolve(answer);
    await call.pending;
    expect(call.respond).toHaveBeenCalledWith(true, {
      content: [
        { type: "text", text: JSON.stringify({ action: "accept", content: { choice: "Blue" } }) },
      ],
    });
  });

  it("preserves model-driven tool calls while the same question handler awaits input", async () => {
    const gatewayCall: AgentQuestionDispatcher = {
      version: 2,
      call: ({ method, params, signal }) => mocks.question(method, params, signal),
    };
    const handler = createMcpClientElicitationHandler({
      sessionKey: "agent:main:model",
      assertCurrent: () => {},
      gatewayCall,
    });
    const call = runWithMcpElicitationHandler(handler, () => runtime.callTool("demo", "pick", {}));
    const completed = call.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await questionStarted.promise;
    await vi.advanceTimersByTimeAsync(500_000);
    questionAnswer.resolve(answer);
    expect(await completed).toEqual({
      result: {
        content: [
          { type: "text", text: JSON.stringify({ action: "accept", content: { choice: "Blue" } }) },
        ],
      },
    });
  });

  it("keeps ordinary tools on their configured deadline", async () => {
    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      toolStarted.resolve();
      return await racePromiseWithAbortSignal(new Promise<never>(() => {}), extra.signal);
    });
    const call = invoke();
    await toolStarted.promise;
    await vi.advanceTimersByTimeAsync(requestTimeoutMs);
    await call.pending;
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("-32001: Request timed out"),
      }),
    );
  });

  it("bounds repeated human questions by one allowance for the whole tool call", async () => {
    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      for (let index = 0; index < 2; index += 1) {
        await server.request(
          {
            method: "elicitation/create",
            params: { message: "Confirm", requestedSchema: { type: "object", properties: {} } },
          },
          resultSchema,
          { timeout: 600_000, signal: extra.signal },
        );
      }
      return { content: [] };
    });
    const call = invoke();
    await questionStarted.promise;
    await vi.advanceTimersByTimeAsync(70_000);
    const firstAnswer = questionAnswer;
    questionAnswer = createDeferred<typeof answer>();
    questionStarted = createDeferred();
    firstAnswer.resolve({ status: "answered", answers: { answers: { confirm: ["Allow"] } } });
    await questionStarted.promise;
    await vi.advanceTimersByTimeAsync(589_999);
    expect(call.respond).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await call.pending;
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("-32001: Request timed out"),
      }),
    );
  });
});

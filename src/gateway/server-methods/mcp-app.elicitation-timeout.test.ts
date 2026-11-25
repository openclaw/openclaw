import { InMemoryTransport } from "@modelcontextprotocol/client";
import { Server, type ElicitRequestParams, type ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSessionMcpRuntime } from "../../agents/agent-bundle-mcp-runtime.js";
import type { McpAppViewLease } from "../../agents/mcp-ui-resource.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { mcpAppHandlers } from "./mcp-app.js";
import { appView } from "./mcp-app.test-support.js";
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
let toolCalls: number;

function elicit(ctx: ServerContext, params: ElicitRequestParams) {
  return ctx.mcpReq.send({ method: "elicitation/create", params }, resultSchema, {
    timeout: 600_000,
    signal: ctx.mcpReq.signal,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  questionStarted = createDeferred();
  questionAnswer = createDeferred<typeof answer>();
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
  server = new Server({ name: "demo", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({
    tools: [{ name: "pick", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler("tools/call", async (_request, ctx) => {
    toolCalls += 1;
    const result = await elicit(ctx, {
      message: "Choose a color",
      requestedSchema: {
        type: "object",
        properties: { choice: { type: "string", enum: ["Blue", "Red"] } },
        required: ["choice"],
      },
    });
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
  view = appView(runtime, {
    viewId: "cv_timeout",
    toolName: "pick",
    html: "",
    allowedAppToolNames: new Set(["pick"]),
    prepareToolCall: async () => {},
  });
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

function expectTimeout(respond: unknown) {
  expect(respond).toHaveBeenCalledWith(false, undefined, {
    code: "UNAVAILABLE",
    message: "Request timed out",
  });
}

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

  it("bounds repeated human questions by one allowance for the whole tool call", async () => {
    server.setRequestHandler("tools/call", async (_request, ctx) => {
      for (let index = 0; index < 2; index += 1) {
        await elicit(ctx, {
          message: "Confirm",
          requestedSchema: { type: "object", properties: {} },
        });
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
    expectTimeout(call.respond);
  });
});

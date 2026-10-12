// MCP HTTP tests cover gateway-scoped tool listing and invocation over the
// JSON-RPC surface, including hook filtering and context propagation.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useMcpCollectorRegistry } from "./mcp-http.collector-registry.test-support.js";
import { EventEmitter } from "node:events";
import { request, ServerResponse } from "node:http";
import { connect } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  raceWithTimeoutResult,
  withTestTimeout,
} from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  markExited,
  recordNotifyOnExitRemoval,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { createProcessTool } from "../agents/bash-tools.process.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
} from "../infra/system-events.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const activeAdmissions: PreparedAgentRunAdmission[] = [];

async function activeAdmission(runId: string): Promise<AdmittedRunContext> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-http-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  activeAdmissions.push(admission);
  return await admission.admit("gateway", `gateway-${runId}`);
}

type MockBeforeToolCallHookResult = Awaited<ReturnType<typeof runBeforeToolCallHook>>;

type ScopedToolsCall = Parameters<typeof resolveGatewayScopedTools>[0] & {
  yieldContextCacheKey?: string;
  nodeExecAllowed?: boolean;
};

type BeforeToolCallHookInput = Parameters<typeof runBeforeToolCallHook>[0];

const runBeforeToolCallHookMock = vi.hoisted(() =>
  vi.fn(async (args: { params: unknown }): Promise<MockBeforeToolCallHookResult> => ({
    blocked: false,
    params: args.params,
  })),
);

const resolveGatewayScopedToolsMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<MockGatewayScopedTools>>(async () => ({
    agentId: "main",
    tools: [
      {
        name: "message",
        label: "Message",
        description: "send a message",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      },
    ],
  })),
);

const loadNodeExecAvailabilityMock = vi.hoisted(() =>
  vi.fn(async () => ({ cacheKey: "eligible", isAvailable: (): boolean => true })),
);

const logWarnMock = vi.hoisted(() => vi.fn<(message: string) => void>());
const sessionEntries = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({ session: { mainKey: "main" } })));

// Partial: the real gateway resolver reaches other exports of this module when a
// test drives it instead of the mock below.
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return {
    ...actual,
    logWarn: (message: string) => logWarnMock(message),
  };
});

// Partial: the real gateway resolver reaches other exports of this module when a
// test drives it instead of the mock below.
vi.mock("../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions.js")>()),
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("../config/sessions/session-accessor.entry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.entry.js")>();
  return {
    ...actual,
    readResolvedSessionEntryInWorker: async (params: { sessionKey: string }) =>
      sessionEntries.get(params.sessionKey),
  };
});

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: (...args: Parameters<typeof runBeforeToolCallHookMock>) =>
    runBeforeToolCallHookMock(...args),
}));

vi.mock("../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: loadNodeExecAvailabilityMock,
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: Parameters<typeof resolveGatewayScopedToolsMock>) =>
    resolveGatewayScopedToolsMock(...args),
}));

import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { getSubagentRunByRunId } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  getActiveMcpLoopbackRuntime,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  waitForMcpLoopbackToolCallCaptureIdle,
} from "./mcp-http.loopback-runtime.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";
import {
  jsonHeaders,
  mcpToolCallBody,
  mcpToolCallMessage,
  readMcpPayload,
  readOkMcpPayload,
  sendLoopbackToolCall,
  sendRaw,
  startLoopbackServerForTest,
  angleSchema,
  objectSchema,
  type McpToolResultPayload,
  type MockGatewayTool,
  type MockGatewayScopedTools,
} from "./mcp-http.test-support.js";

const MAIN_SESSION_HEADER = { "x-session-key": "agent:main:main" };
const ANGLE_NUMBER_PROPERTY = { type: "number" };
const SSE_TEST_READ_TIMEOUT_MS = 100;

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return withTestTimeout(
    reader.read(),
    SSE_TEST_READ_TIMEOUT_MS,
    "timed out waiting for SSE response body",
  );
}

async function expectPromiseResolvesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return withTestTimeout(promise, timeoutMs, `${label} timed out after ${timeoutMs}ms`);
}

async function readUntilInitialSseCommentFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  let bodyPrefix = "";
  while (!bodyPrefix.includes(":\n\n")) {
    const chunk = await readStreamChunkWithTimeout(reader);
    expect(chunk.done).toBe(false);
    bodyPrefix += decoder.decode(chunk.value, { stream: true });
    if (bodyPrefix.length > 64) {
      throw new Error(`SSE response did not start with a comment frame: ${bodyPrefix}`);
    }
  }
  expect(bodyPrefix.startsWith(":\n\n")).toBe(true);
}

async function expectInitialSseCommentFrame(res: Response): Promise<void> {
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.body).toBeTruthy();
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("expected SSE response body");
  }
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  try {
    await readUntilInitialSseCommentFrame(reader);

    pendingRead = reader.read();
    const immediateClose = Symbol("immediate-close");
    const result = await raceWithTimeoutResult<
      ReadableStreamReadResult<Uint8Array> | typeof immediateClose
    >(pendingRead, SSE_TEST_READ_TIMEOUT_MS, immediateClose);
    expect(result).toBe(immediateClose);
  } finally {
    await reader.cancel();
    await pendingRead?.catch(() => undefined);
    reader.releaseLock();
  }
}

function openMcpRequest(params: { port: number; token: string; headers?: Record<string, string> }) {
  const response = createDeferred<{ status: number | undefined; body: string }>();
  const req = request(
    {
      hostname: "127.0.0.1",
      port: params.port,
      path: "/mcp",
      method: "POST",
      headers: {
        authorization: `Bearer ${params.token}`,
        "content-type": "application/json",
        ...params.headers,
      },
    },
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => response.resolve({ status: res.statusCode, body }));
    },
  );
  req.on("error", response.reject);
  return { req, response: response.promise };
}

type GrantOptions = Omit<
  Parameters<typeof mintMcpLoopbackClientGrant>[0],
  "context" | "runtimeOwnerToken"
> & {
  context?: Partial<McpLoopbackRequestContext>;
  captureKey?: string;
};

async function createCliGrant(
  runId: string,
  { context, captureKey = `capture-${runId}`, ...options }: GrantOptions = {},
) {
  const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "active MCP loopback runtime");
  const grant = mintMcpLoopbackClientGrant({
    context: { sessionKey: "agent:main:main", senderIsOwner: true, ...context },
    runtimeOwnerToken: runtime.ownerToken,
    admittedRunContext: options.admittedRunContext ?? (await activeAdmission(runId)),
    ...options,
  });
  const captureParams = { token: grant.token, runtimeOwnerToken: runtime.ownerToken, captureKey };
  const capture = activateMcpLoopbackClientGrantCapture(captureParams);
  if (!capture) {
    throw new Error("expected an active CLI grant capture");
  }
  return {
    ...grant,
    capture,
    captureParams,
    scope: { token: grant.token, headers: captureHeaders(captureKey) },
  };
}

function captureHeaders(captureKey: string) {
  return { "x-openclaw-cli-capture-key": captureKey };
}

async function sendDelayedBody(params: {
  port: number;
  token: string;
  body: string;
  delayMs: number;
}) {
  const { req, response } = openMcpRequest({
    ...params,
    headers: { "transfer-encoding": "chunked" },
  });
  req.flushHeaders();
  const timer = setTimeout(() => req.end(params.body), params.delayMs);
  try {
    return await withTestTimeout(response, 2_000, "stalled body test timed out");
  } finally {
    clearTimeout(timer);
    req.destroy();
  }
}

async function sendLoopbackToolsList(params: {
  token?: string;
  headers?: Record<string, string>;
  id?: number;
}) {
  return sendRaw({
    port: getActiveMcpLoopbackRuntime()?.port ?? 0,
    token: params.token,
    headers: jsonHeaders(params.headers),
    body: mcpToolsListBody(params.id),
  });
}

async function sendMainSessionToolCall(params: {
  token?: string;
  name?: string;
  args?: Record<string, unknown>;
}) {
  return sendLoopbackToolCall({
    token: params.token,
    name: params.name ?? "message",
    args: params.args,
    headers: MAIN_SESSION_HEADER,
  });
}

async function callMainSessionTool(params: {
  token?: string;
  name?: string;
  args?: Record<string, unknown>;
}) {
  return readOkMcpPayload(await sendMainSessionToolCall(params));
}

async function expectBrowserToolsListStatus(params: {
  origin: string;
  fetchSite?: string;
  token?: "owner" | "none";
  status: number;
}) {
  const { runtime, port } = await startLoopbackServerForTest();
  const response = await sendRaw({
    port,
    token: params.token === "none" ? undefined : runtime?.ownerToken,
    headers: jsonHeaders({
      origin: params.origin,
      ...(params.fetchSite ? { "sec-fetch-site": params.fetchSite } : {}),
    }),
    body: mcpToolsListBody(),
  });

  expect(response.status).toBe(params.status);
}

function expectMcpToolNames(payload: McpToolResultPayload, expected: string[]) {
  const names = (payload.result?.tools ?? []).map((tool) => tool.name);
  for (const name of expected) {
    expect(names).toContain(name);
  }
}

function expectMcpResultText(payload: McpToolResultPayload, text: string, isError?: boolean) {
  if (isError === undefined) {
    expect(payload.result?.isError).not.toBe(true);
  } else {
    expect(payload.result?.isError).toBe(isError);
  }
  expect(payload.result?.content?.[0]?.text).toBe(text);
}

function getScopedToolsCall(index: number): ScopedToolsCall {
  const call = resolveGatewayScopedToolsMock.mock.calls[index]?.[0];
  if (typeof call !== "object" || call === null) {
    throw new Error(`Expected scoped tools call ${index} to receive an options object`);
  }
  return call as ScopedToolsCall;
}

function getBeforeToolCallHookInput(index: number): BeforeToolCallHookInput {
  const call = runBeforeToolCallHookMock.mock.calls[index]?.[0];
  if (typeof call !== "object" || call === null) {
    throw new Error(`Expected before-tool-call hook ${index} to receive an input object`);
  }
  return call as BeforeToolCallHookInput;
}

function makeMockTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
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

function makeMessageTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return makeMockTool({
    name: "message",
    description: "send a message",
    ...overrides,
  });
}

function makeCronTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return makeMockTool({
    name: "cron",
    description: "manage schedules",
    ...overrides,
  });
}

function mockScopedTools(tools: MockGatewayTool[]) {
  resolveGatewayScopedToolsMock.mockResolvedValue({
    agentId: "main",
    tools,
  });
}

function mcpToolsListBody(id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
}

function buildMockMcpToolSchema(tools: MockGatewayTool[]) {
  return buildMcpToolSchema(tools as unknown as Parameters<typeof buildMcpToolSchema>[0]);
}

type McpToolCacheParams = Parameters<McpLoopbackToolCache["resolve"]>[0];

function createMcpToolCacheResolver({
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

beforeEach(() => {
  getRuntimeConfigMock.mockReset().mockImplementation(() => ({ session: { mainKey: "main" } }));
  loadNodeExecAvailabilityMock
    .mockReset()
    .mockResolvedValue({ cacheKey: "eligible", isAvailable: () => true });
  logWarnMock.mockClear();
  sessionEntries.clear();
  resolveGatewayScopedToolsMock.mockClear();
  runBeforeToolCallHookMock.mockClear();
  runBeforeToolCallHookMock.mockImplementation(
    async (args: { params: unknown }): Promise<MockBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  );
  mockScopedTools([makeMessageTool()]);
});

afterEach(async () => {
  await closeMcpLoopbackServer();
  for (const admission of activeAdmissions.splice(0)) {
    admission.close();
  }
});

describe("MCP terminal process result delivery", () => {
  const sessionKey = "agent:main:mcp-delivery";
  const processId = "mcp-delivery-process";
  let poll: MockGatewayTool["execute"];

  beforeEach(() => {
    const session = createProcessSessionFixture({ id: processId, backgrounded: true });
    session.scopeKey = sessionKey;
    session.sessionKey = sessionKey;
    addSession(session);
    appendOutput(session, "stdout", "completed output");
    markExited(session, 0, null, "completed");
    enqueueSystemEventWithReceipt("unrelated event", { sessionKey, contextKey: "other" });
    recordNotifyOnExitRemoval(
      session,
      enqueueSystemEventWithReceipt("exec completed", { sessionKey, contextKey: processId })!,
    );
    const processTool = createProcessTool({ scopeKey: sessionKey });
    poll = async () => processTool.execute("mcp-poll", { action: "poll", sessionId: processId });
    mockScopedTools([makeMessageTool({ execute: poll })]);
  });

  afterEach(() => {
    deleteSession(processId);
    drainSystemEventEntries(sessionKey);
    vi.restoreAllMocks();
  });

  it("acknowledges only the completed HTTP result and preserves unrelated events", async () => {
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below binds the response receiver.
    const writeHead = ServerResponse.prototype.writeHead;
    vi.spyOn(ServerResponse.prototype, "writeHead").mockImplementation(function (
      this: ServerResponse,
      ...args
    ) {
      expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
        "unrelated event",
        "exec completed",
      ]);
      return Reflect.apply(writeHead, this, args);
    });
    const { runtime } = await startLoopbackServerForTest();
    const payload = await callMainSessionTool({ token: runtime.ownerToken });
    expect(payload.result?.content?.[0]?.text).toContain("completed output");
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
      "unrelated event",
    ]);
  });

  it("keeps the notification when result serialization fails", async () => {
    mockScopedTools([
      makeMessageTool({
        execute: async () => Object.assign(await poll(), { content: [1n] }),
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();
    const payload = await callMainSessionTool({ token: runtime.ownerToken });
    expect(payload.result?.isError).toBe(true);
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
      "unrelated event",
      "exec completed",
    ]);
  });

  it("keeps the notification when the response connection closes before its bytes finish", async () => {
    vi.spyOn(ServerResponse.prototype, "end").mockImplementationOnce(function (
      this: ServerResponse,
    ) {
      this.destroy();
      return this;
    });
    const { runtime } = await startLoopbackServerForTest();
    await expect(sendMainSessionToolCall({ token: runtime.ownerToken })).rejects.toThrow();
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
      "unrelated event",
      "exec completed",
    ]);
  });
});

describe("buildMcpToolSchema", () => {
  it("preserves own prototype-named union properties without requiring inherited names", () => {
    const properties = Object.fromEntries(
      ["__proto__", "toString"].map((key) => [key, { type: "string" }]),
    );
    const [entry] = buildMockMcpToolSchema([
      makeMockTool({
        name: "proof_tool",
        description: "proof",
        parameters: {
          anyOf: [{ type: "object", properties, required: ["__proto__", "toString", "valueOf"] }],
        },
      }),
    ]);
    expect(entry?.inputSchema.properties).toEqual(properties);
    expect(Object.keys(entry?.inputSchema.properties ?? {})).toEqual(["__proto__", "toString"]);
    expect(JSON.stringify(entry?.inputSchema.properties)).toContain('"__proto__"');
    expect(entry?.inputSchema.required).toEqual(["__proto__", "toString"]);
  });

  it("flattens usable schemas from malformed and boolean union variants", () => {
    const cases: Array<{
      name: string;
      parameters: Record<string, unknown>;
      expected: Record<string, unknown>;
    }> = [
      {
        name: "fuzzplugin_move_delta",
        parameters: {
          anyOf: [angleSchema(null, ["angle"]), angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"])],
        },
        expected: angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"]),
      },
      {
        name: "fuzzplugin_optional_delta",
        parameters: {
          anyOf: [angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"]), true],
        },
        expected: angleSchema(ANGLE_NUMBER_PROPERTY),
      },
      {
        name: "fuzzplugin_boolean_delta",
        parameters: {
          anyOf: [angleSchema(false), angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"])],
        },
        expected: angleSchema(ANGLE_NUMBER_PROPERTY),
      },
    ];

    for (const testCase of cases) {
      expect(
        buildMockMcpToolSchema([
          makeMockTool({
            name: testCase.name,
            parameters: testCase.parameters,
          }),
        ])[0]?.inputSchema,
      ).toEqual(testCase.expected);
    }
  });

  it("unions compatible literals while preserving distinct validation constraints", () => {
    const action = (schema: Record<string, unknown>, constrained: string) =>
      objectSchema(
        {
          action: schema,
          constrained: { type: "string", const: constrained, pattern: "^" + constrained + "$" },
          thread_id: { type: "string" },
        },
        ["action"],
      );
    const tool = makeMockTool({
      name: "literal_union",
      parameters: {
        anyOf: [
          action(
            {
              type: "string",
              const: "list",
              enum: ["list", "ignored"],
              description: "List threads",
            },
            "list",
          ),
          action({ type: "string", const: "fork", description: "Fork a thread" }, "fork"),
          action({ type: "string", const: "rename" }, "rename"),
          action({ type: "string", enum: ["archive", "unarchive"] }, "archive"),
        ],
      },
    });
    expect(buildMockMcpToolSchema([tool])[0]?.inputSchema).toEqual(
      objectSchema(
        {
          action: {
            type: "string",
            enum: ["list", "fork", "rename", "archive", "unarchive"],
            description: "List threads",
          },
          constrained: { type: "string", const: "list", pattern: "^list$" },
          thread_id: { type: "string" },
        },
        ["action"],
      ),
    );
    expect(logWarnMock.mock.calls.map(([message]) => message)).toEqual([
      'mcp-loopback: conflicting schema definitions for "literal_union.constrained", keeping the first variant',
    ]);
  });
});

describe("mcp loopback server", () => {
  it("keeps equal schemas quiet and dedupes genuine conflicts across HTTP cache misses", async () => {
    mockScopedTools([
      makeMockTool({
        name: "lark_doc_read",
        parameters: {
          oneOf: [
            objectSchema({
              doc_token: { type: "string", description: "Lark document token", minLength: 1 },
              action: { type: "string" },
              callId: { type: "string" },
            }),
            objectSchema({
              doc_token: { minLength: 1, description: "Lark document token", type: "string" },
              action: { type: "number" },
              callId: { type: "number" },
            }),
          ],
        },
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();

    for (let index = 0; index < 3; index += 1) {
      const payload = await readOkMcpPayload(
        await sendLoopbackToolsList({
          token: runtime.ownerToken,
          headers: {
            ...MAIN_SESSION_HEADER,
            "x-openclaw-current-message-id": `message-${index}`,
          },
        }),
      );
      expectMcpToolNames(payload, ["lark_doc_read"]);
      expect(payload.result?.tools?.[0]?.inputSchema).toMatchObject(
        objectSchema({
          doc_token: { type: "string", description: "Lark document token", minLength: 1 },
          action: { type: "string" },
          callId: { type: "string" },
        }),
      );
    }

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(3);
    expect(logWarnMock.mock.calls.map(([message]) => message)).toEqual([
      'mcp-loopback: conflicting schema definitions for "lark_doc_read.action", keeping the first variant',
      'mcp-loopback: conflicting schema definitions for "lark_doc_read.callId", keeping the first variant',
    ]);
  });

  it("suppresses reserved-harness errors for notifications", async () => {
    const { runtime, port } = await startLoopbackServerForTest();
    const headers = {
      "content-type": "application/json",
      "x-session-key": "agent:main:harness:codex:supervision:native-thread",
    };
    const notificationResponse = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
    });
    const mixedResponse = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers,
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "tools/list" },
        { jsonrpc: "2.0", id: 42, method: "tools/list" },
      ]),
    });

    expect(notificationResponse.status).toBe(202);
    await expect(notificationResponse.text()).resolves.toBe("");
    expect(mixedResponse.status).toBe(200);
    await expect(mixedResponse.json()).resolves.toEqual([
      expect.objectContaining({
        id: 42,
        error: { code: -32600, message: expect.stringContaining("reserved") },
      }),
    ]);
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
  });

  it("rejects an existing locked harness context", async () => {
    const { runtime } = await startLoopbackServerForTest();
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    sessionEntries.set(sessionKey, {
      sessionId: "locked-session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    const response = await sendLoopbackToolsList({
      token: runtime.ownerToken,
      headers: { "x-session-key": sessionKey },
    });

    expect(await response.json()).toMatchObject({
      error: { code: -32600, message: expect.stringContaining("reserved") },
    });
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
  });

  it("passes session, account, message channel, and inbound event headers into shared tool resolution", async () => {
    const { runtime } = await startLoopbackServerForTest();
    const response = await sendLoopbackToolsList({
      token: runtime.nonOwnerToken,
      headers: {
        "x-session-key": "agent:main:telegram:group:chat123",
        "x-openclaw-session-id": "session-123",
        "x-openclaw-account-id": "work",
        "x-openclaw-message-channel": "telegram",
        "x-openclaw-client-caps": " tool-events, inline-widgets,tool-events, , ",
        "x-openclaw-sender-is-owner": "true",
        "x-openclaw-pinned-widget-authoring": "true",
        "x-openclaw-current-channel-id": "telegram:chat123",
        "x-openclaw-current-thread-ts": "42",
        "x-openclaw-current-message-id": "reply-message-1",
        "x-openclaw-current-inbound-audio": "true",
        "x-openclaw-inbound-event-kind": "room_event",
        "x-openclaw-source-reply-delivery-mode": "message_tool_only",
        "x-openclaw-task-suggestion-delivery-mode": "gateway",
        "x-openclaw-require-explicit-message-target": "true",
      },
    });

    expect(response.status).toBe(200);
    const call = getScopedToolsCall(0);
    expect(call.sessionKey).toBe("agent:main:telegram:group:chat123");
    expect(call.sessionId).toBe("session-123");
    expect(call.accountId).toBe("work");
    expect(call.messageProvider).toBe("telegram");
    expect(call.clientCaps).toEqual(["tool-events", "inline-widgets"]);
    expect(call.pinnedWidgetAuthoring).toBeUndefined();
    expect(call.currentChannelId).toBe("telegram:chat123");
    expect(call.currentThreadTs).toBe("42");
    expect(call.currentMessageId).toBe("reply-message-1");
    expect(call.currentInboundAudio).toBe(true);
    expect(call.inboundEventKind).toBe("room_event");
    expect(call.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call.taskSuggestionDeliveryMode).toBe("gateway");
    expect(call.requireExplicitMessageTarget).toBe(true);
    expect(call.conversationReadOrigin).toBe("delegated");
    expect(call.senderIsOwner).toBe(false);
    expect(call.surface).toBe("loopback");
    expect(call.includeNodeExecTool).toBe(false);
    expect(new Set(call.excludeToolNames)).toEqual(
      new Set(["read", "write", "edit", "ls", "apply_patch", "exec", "process"]),
    );
  });

  it("binds an attach grant's session owner and ignores ALL spoofed context headers", async () => {
    const grant = mintAttachGrant({ sessionKey: "global", agentId: "ops" });
    await startLoopbackServerForTest();
    const response = await sendLoopbackToolsList({
      token: grant.token,
      headers: {
        "x-session-key": "agent:main:SPOOFED-other-session",
        "x-openclaw-message-channel": "telegram",
        "x-openclaw-client-caps": "inline-widgets",
        "x-openclaw-pinned-widget-authoring": "true",
        "x-openclaw-account-id": "victim-account",
        "x-openclaw-current-channel-id": "telegram:victim-chat",
        "x-openclaw-current-thread-ts": "999",
        "x-openclaw-source-reply-delivery-mode": "automatic",
        "x-openclaw-source-reply-only": "true",
        "x-openclaw-inbound-event-kind": "room_event",
      },
    });

    expect(response.status).toBe(200);
    const call = getScopedToolsCall(0);
    expect(call.sessionKey).toBe("global");
    expect(call.agentId).toBe("ops");
    expect(call.senderIsOwner).toBe(false);
    expect(call.surface).toBe("loopback");
    expect(call.messageProvider).toBeUndefined();
    expect(call.clientCaps).toBeUndefined();
    expect(call.pinnedWidgetAuthoring).toBeUndefined();
    expect(call.accountId).toBeUndefined();
    expect(call.currentChannelId).toBeUndefined();
    expect(call.currentThreadTs).toBeUndefined();
    expect(call.sourceReplyDeliveryMode).toBeUndefined();
    expect(call.sourceReplyOnly).toBeUndefined();
    expect(call.inboundEventKind).toBeUndefined();
    expect(call.conversationReadOrigin).toBe("delegated");
    expect(call.includeNodeExecTool).toBe(false);
    expect(Array.from(call.excludeToolNames ?? [])).toContain("exec");
  });

  it("binds a CLI grant's complete context and ignores spoofed scope headers", async () => {
    const { port } = await startLoopbackServerForTest();
    const admittedRunContext = await activeAdmission("run-bound");
    let toolCallerIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;
    resolveGatewayScopedToolsMock.mockResolvedValue({
      agentId: "main",
      workspaceDir: "/tmp/openclaw-workspace",
      tools: [
        makeMessageTool({
          label: "Message",
          execute: async () => {
            toolCallerIdentity = getGatewayToolCallerIdentity();
            return { content: [{ type: "text", text: "ok" }] };
          },
        }),
      ],
    });
    const boundContext = {
      sessionKey: "agent:main:discord:channel:bound",
      runtimePolicySessionKey: "agent:worker:discord:default:direct:bound-user",
      runtimePolicyAgentId: "worker",
      agentId: "main",
      sessionId: "session-bound",
      runId: "run-bound",
      modelProvider: "anthropic",
      modelId: "claude-opus-4-7",
      modelHasVision: true,
      messageProvider: "discord",
      clientCaps: ["tool-events"],
      pinnedWidgetAuthoring: true,
      currentChannelId: "discord:bound",
      // Native channel id and routable target diverge (Slack-style native
      // conversation vs user route). turnSourceTo must carry the routable
      // target on both the hook and the admitted caller identity.
      currentMessagingTarget: "discord:user:routable",
      currentThreadTs: "bound-thread",
      currentMessageId: "bound-message",
      currentInboundAudio: true,
      accountId: "bound-account",
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplyOnly: true,
      toolsAllow: ["message"],
      nativeCronCreatorToolAllowlist: ["read", "write", "edit", "apply_patch", "exec", "process"],
      // The delegation gate lives in resolveGatewayScopedTools, so dropping
      // this field at the HTTP mapping silently disables it for CLI backends.
      delegationCapability: "report_only",
      taskSuggestionDeliveryMode: "gateway",
      requireExplicitMessageTarget: true,
      senderIsOwner: false,
      nodeExecAllowed: true,
      execOverrides: {
        host: "node",
        security: "allowlist",
        ask: "always",
        node: "mac-b",
      },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
      approvalReviewerDeviceId: "bound-reviewer",
      senderName: "Bound Name",
      senderUsername: "bound-user",
      senderE164: "+15557654321",
      groupId: "bound",
      groupChannel: "ops",
      groupSpace: "guild-bound",
      spawnedBy: "agent:main:discord:channel:parent",
    } satisfies McpLoopbackRequestContext;
    const { capture, ...grant } = await createCliGrant("run-bound", {
      context: boundContext,
      admittedRunContext,
      captureKey: "capture-bound",
    });
    expect(capture.captureNativeToolAuthority(boundContext.nativeCronCreatorToolAllowlist)).toBe(
      true,
    );

    const sendWithCapture = async (captureKey?: string, method: "list" | "call" = "list") =>
      await sendRaw({
        port,
        token: grant.token,
        headers: jsonHeaders({
          ...(captureKey ? { "x-openclaw-cli-capture-key": captureKey } : {}),
          "x-session-key": "agent:main:main",
          "x-openclaw-session-id": "session-spoofed",
          "x-openclaw-message-channel": "telegram",
          "x-openclaw-client-caps": "inline-widgets,admin",
          "x-openclaw-pinned-widget-authoring": "false",
          "x-openclaw-account-id": "spoofed-account",
          "x-openclaw-current-channel-id": "telegram:spoofed",
          "x-openclaw-current-thread-ts": "spoofed-thread",
          "x-openclaw-current-message-id": "spoofed-message",
          "x-openclaw-current-inbound-audio": "false",
          "x-openclaw-inbound-event-kind": "room_event",
          "x-openclaw-source-reply-delivery-mode": "automatic",
          "x-openclaw-source-reply-only": "false",
          "x-openclaw-task-suggestion-delivery-mode": "direct",
          "x-openclaw-require-explicit-message-target": "false",
        }),
        body: method === "call" ? mcpToolCallBody("message") : mcpToolsListBody(),
      });

    expect((await sendWithCapture()).status).toBe(401);
    expect((await sendWithCapture("capture-forged")).status).toBe(401);
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();

    expect((await sendWithCapture("capture-bound")).status).toBe(200);
    expect((await sendWithCapture("capture-bound", "call")).status).toBe(200);
    const { runId: _runId, toolsAllow: _toolsAllow, ...resolvedContext } = boundContext;
    const expectedBoundContext = {
      ...resolvedContext,
      surface: "loopback",
    };
    expect(getScopedToolsCall(0)).toMatchObject(expectedBoundContext);
    expect(getScopedToolsCall(1)).toMatchObject(expectedBoundContext);
    expect(getScopedToolsCall(0).includeNodeExecTool).toBe(true);
    expect(Array.from(getScopedToolsCall(0).excludeToolNames ?? [])).not.toContain("exec");
    expect(getBeforeToolCallHookInput(0).ctx).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:discord:channel:bound",
      sessionId: "session-bound",
      runId: "run-bound",
      workspaceDir: "/tmp/openclaw-workspace",
      approvalReviewerDeviceId: "bound-reviewer",
      channelId: "discord:bound",
      turnSourceChannel: "discord",
      turnSourceTo: "discord:user:routable",
      turnSourceAccountId: "bound-account",
      turnSourceThreadId: "bound-thread",
    });
    expect(getBeforeToolCallHookInput(0).ctx).toHaveProperty("loopDetection");
    expect(toolCallerIdentity).toMatchObject({
      agentId: "main",
      sessionKey: boundContext.sessionKey,
      operationalRunInstance: admittedRunContext.operationalRunInstance,
      turnSourceChannel: boundContext.messageProvider,
      turnSourceTo: boundContext.currentMessagingTarget,
      turnSourceAccountId: boundContext.accountId,
      turnSourceThreadId: boundContext.currentThreadTs,
    });
  });

  it("allows native discovery but denies calls until the current turn observes its tools", async () => {
    getRuntimeConfigMock.mockReturnValue({ session: { mainKey: "main" } });
    const execute = vi.fn(async (nativeTools: readonly string[] | null | undefined) => ({
      content: [{ type: "text", text: JSON.stringify(nativeTools) }],
    }));
    resolveGatewayScopedToolsMock.mockImplementation(async () => {
      const { nativeCronCreatorToolAllowlist } = getScopedToolsCall(
        resolveGatewayScopedToolsMock.mock.calls.length - 1,
      );
      return {
        agentId: "main",
        tools: [makeMessageTool({ execute: () => execute(nativeCronCreatorToolAllowlist) })],
      };
    });
    await startLoopbackServerForTest();
    const { capture, scope: requestScope } = await createCliGrant("run-native-discovery", {
      context: { nativeCronCreatorToolAllowlist: ["read", "exec"] },
      captureKey: "capture-native-discovery",
    });

    expectMcpToolNames(await readOkMcpPayload(await sendLoopbackToolsList(requestScope)), [
      "message",
    ]);
    const response = await sendLoopbackToolCall({ ...requestScope, name: "message" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      error: { code: -32000, message: expect.stringMatching(/retry|wait|initializ/i) },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(capture.captureNativeToolAuthority(["read"])).toBe(true);
    expectMcpResultText(
      await readOkMcpPayload(await sendLoopbackToolCall({ ...requestScope, name: "message" })),
      '["read"]',
    );
    expect(capture.captureNativeToolAuthority([])).toBe(true);
    expectMcpResultText(
      await readOkMcpPayload(await sendLoopbackToolCall({ ...requestScope, name: "message" })),
      "[]",
    );
    expect(capture.captureNativeToolAuthority(null)).toBe(true);
    expect(
      await (await sendLoopbackToolCall({ ...requestScope, name: "message" })).json(),
    ).toMatchObject({
      error: { code: -32000 },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps prepared auth stores isolated between CLI grants", async () => {
    await startLoopbackServerForTest();
    const firstStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "xai:first": { type: "token", provider: "xai", token: "first-token" },
      },
    };
    const secondStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "xai:second": { type: "token", provider: "xai", token: "second-token" },
      },
    };
    const firstGrant = await createCliGrant("run-auth-/agents/first", {
      captureKey: "capture-first",
      toolAuth: { agentDir: "/agents/first", store: firstStore },
    });
    const secondGrant = await createCliGrant("run-auth-/agents/second", {
      captureKey: "capture-second",
      toolAuth: { agentDir: "/agents/second", store: secondStore },
    });
    expect((await sendLoopbackToolsList(firstGrant.scope)).status).toBe(200);
    expect((await sendLoopbackToolsList(secondGrant.scope)).status).toBe(200);

    expect(getScopedToolsCall(0)).toMatchObject({
      agentDir: "/agents/first",
      authProfileStore: firstStore,
    });
    expect(getScopedToolsCall(1)).toMatchObject({
      agentDir: "/agents/second",
      authProfileStore: secondStore,
    });
  });

  it("revalidates admitted authority after async preparation before tool execution", async () => {
    const { promise: preparationGate, resolve: releasePreparation } = createDeferred();
    const { promise: preparationStarted, resolve: markPreparationStarted } = createDeferred();
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "should not execute" }],
    }));
    mockScopedTools([
      makeMockTool({
        name: "exec",
        prepareBeforeToolCallParams: async (args) => {
          markPreparationStarted();
          await preparationGate;
          return args;
        },
        execute,
      }),
    ]);
    await startLoopbackServerForTest();
    const grant = await createCliGrant("run-revoked-during-prepare", {
      context: { nodeExecAllowed: true },
      captureKey: "capture-revoked-during-prepare",
    });
    const responsePromise = sendLoopbackToolCall({ ...grant.scope, name: "exec" });
    await preparationStarted;
    activeAdmissions.at(-1)?.close();
    releasePreparation();

    const response = await responsePromise;
    const payload = await readMcpPayload(response);
    expect(response.status).toBe(200);
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content).toEqual([
      { type: "text", text: "Tool call authorization expired" },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a slow tools request replaced after header admission", async () => {
    const captureKey = "slow-revoked-grant";
    const { promise: requestStarted, resolve: resolveRequestStarted } = createDeferred();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onRequestStart: () => resolveRequestStarted?.(),
      onRequestClassified: vi.fn(),
      onToolCallResult: vi.fn(),
    });
    const { port } = await startLoopbackServerForTest();
    const grant = await createCliGrant("run-slow-revoked", {
      context: { sessionKey: "agent:main:slow-revoked" },
      captureKey,
      toolAuth: { store: { version: 1, profiles: {} } },
    });

    let changed = false;
    const { req, response: responsePromise } = openMcpRequest({
      port,
      token: grant.token,
      headers: { "transfer-encoding": "chunked", ...captureHeaders(captureKey) },
    });
    req.flushHeaders();
    void requestStarted.then(() => {
      changed = activateMcpLoopbackClientGrantCapture(grant.captureParams) !== false;
      req.end(mcpToolsListBody());
    });

    await requestStarted;
    const resolverCallsBeforeBody = resolveGatewayScopedToolsMock.mock.calls.length;
    expect((await responsePromise).status).toBe(401);
    expect(changed).toBe(true);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(resolverCallsBeforeBody);
    clearMcpLoopbackToolCallCapture(captureKey);
    expect(
      (
        await sendLoopbackToolsList({
          token: grant.token,
          headers: captureHeaders(captureKey),
        })
      ).status,
    ).toBe(200);
  });

  it("rejects a grant revoked while node availability is being resolved", async () => {
    const entered = createDeferred();
    const availability = createDeferred<{ cacheKey: string; isAvailable: () => boolean }>();
    loadNodeExecAvailabilityMock.mockImplementationOnce(() => {
      entered.resolve();
      return availability.promise;
    });
    await startLoopbackServerForTest();
    const captureKey = "node-availability-revoked";
    const grant = await createCliGrant("node-availability-revoked", {
      context: { sessionKey: "agent:main:node-availability", nodeExecAllowed: true },
      captureKey,
      toolAuth: { store: { version: 1, profiles: {} } },
    });
    const response = sendLoopbackToolsList(grant.scope);
    await entered.promise;
    expect(revokeMcpLoopbackClientGrant(grant.token)).toBe(true);
    availability.resolve({ cacheKey: "eligible", isAvailable: () => true });
    expect((await response).status).toBe(401);
  });

  it("does not dispatch after the HTTP client disconnects during node discovery", async () => {
    const entered = createDeferred();
    const availability = createDeferred<{ cacheKey: string; isAvailable: () => boolean }>();
    loadNodeExecAvailabilityMock.mockImplementationOnce(() => {
      entered.resolve();
      return availability.promise;
    });
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({ content: [] }));
    mockScopedTools([makeMessageTool({ execute })]);
    const { port } = await startLoopbackServerForTest();
    const captureKey = "node-discovery-disconnect";
    const grant = await createCliGrant(captureKey, {
      context: { sessionKey: "agent:main:disconnected", nodeExecAllowed: true },
      captureKey,
      toolAuth: { store: { version: 1, profiles: {} } },
    });
    beginMcpLoopbackToolCallCapture({ captureKey, onToolCallResult: vi.fn() });
    const disconnected = createDeferred();
    const responseEvents = vi.spyOn(ServerResponse.prototype, "emit").mockImplementation(function (
      this: ServerResponse,
      event,
      ...args
    ) {
      const emitted = EventEmitter.prototype.emit.call(this, event, ...args);
      if (event === "close") {
        disconnected.resolve();
      }
      return emitted;
    });
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: jsonHeaders({
        authorization: `Bearer ${grant.token}`,
        "x-openclaw-cli-capture-key": captureKey,
      }),
    });
    req.on("error", () => {});
    req.end(mcpToolCallBody("message"));
    try {
      await entered.promise;
      req.destroy();
      // Observe the server's close event before releasing discovery, not a timed delay.
      await disconnected.promise;
      availability.resolve({ cacheKey: "eligible", isAvailable: () => true });
      expect(
        await waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
          timeoutMs: 1_000,
          admissionGraceMs: 0,
        }),
      ).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      responseEvents.mockRestore();
      req.destroy();
      availability.resolve({ cacheKey: "eligible", isAvailable: () => true });
      clearMcpLoopbackToolCallCapture(captureKey);
    }
  });

  it("fences caller authority when the grant is replaced during tool execution", async () => {
    const { promise: started, resolve: markStarted } = createDeferred();
    const { promise: gate, resolve: release } = createDeferred();
    let committed = false;
    mockScopedTools([
      makeMessageTool({
        execute: async () => {
          const caller = getGatewayToolCallerIdentity();
          markStarted();
          await gate;
          if (caller?.receiptAuthority?.() !== true) {
            throw new Error("Grant authority expired before publication");
          }
          committed = true;
          return { content: [{ type: "text", text: "published" }] };
        },
      }),
    ]);
    await startLoopbackServerForTest();
    const grant = await createCliGrant("run-publication", {
      context: { sessionKey: "agent:main:publication" },
      captureKey: "capture-publication",
    });
    const response = sendLoopbackToolCall({ ...grant.scope, name: "message" });
    await started;
    activateMcpLoopbackClientGrantCapture(grant.captureParams);
    release();
    expectMcpResultText(
      await readOkMcpPayload(await response),
      "Grant authority expired before publication",
      true,
    );
    expect(committed).toBe(false);
  });

  it("routes sessions_yield to the current CLI capture", async () => {
    resolveGatewayScopedToolsMock.mockImplementation(
      async (input): Promise<MockGatewayScopedTools> => {
        const call = input as ScopedToolsCall;
        return {
          agentId: "main",
          tools: [
            makeMockTool({
              name: "sessions_yield",
              execute: async (_toolCallId, args) => {
                if (!call.sessionId) {
                  throw new Error("No session context");
                }
                if (!call.onYield) {
                  throw new Error("Yield not supported in this context");
                }
                const { message = "Turn yielded.", acknowledgment } = args as {
                  message?: string;
                  acknowledgment?: string;
                };
                await call.onYield(message, acknowledgment);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ status: "yielded", message, acknowledgment }),
                    },
                  ],
                };
              },
            }),
          ],
        };
      },
    );
    const { runtime } = await startLoopbackServerForTest();
    const firstYield = vi.fn();
    const secondYield = vi.fn();
    const sendYield = async (
      captureKey: string,
      message: string,
      acknowledgment: string,
      onYield: (message: string, acknowledgment?: string) => void,
    ) => {
      beginMcpLoopbackToolCallCapture({
        captureKey,
        onYield,
        onToolCallResult: vi.fn(),
      });
      return await sendLoopbackToolCall({
        token: runtime.ownerToken,
        name: "sessions_yield",
        args: { message, acknowledgment },
        headers: {
          "x-session-key": "agent:main:main",
          "x-openclaw-session-id": "session-reused",
          "x-openclaw-cli-capture-key": captureKey,
        },
      });
    };

    const captureKey = "capture-reused";
    expect((await sendYield(captureKey, "first yield", "First wait", firstYield)).status).toBe(200);
    expect((await sendYield(captureKey, "second yield", "Second wait", secondYield)).status).toBe(
      200,
    );

    expect(firstYield).toHaveBeenCalledWith("first yield", "First wait");
    expect(secondYield).toHaveBeenCalledWith("second yield", "Second wait");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
  });

  it("keeps explicit non-owner and unknown-owner loopback cache entries separate", async () => {
    const baseContext = {
      cfg: { session: { mainKey: "main" } },
      currentChannelId: "telegram:chat123",
      currentMessageId: "message-1",
      currentThreadTs: "thread-1",
      inboundEventKind: "room_event",
      messageProvider: "telegram",
      senderIsOwner: undefined,
      sessionKey: "agent:main:telegram:group:chat123",
      sourceReplyDeliveryMode: "message_tool_only",
    } satisfies Parameters<typeof createMcpToolCacheResolver>[0];
    resolveGatewayScopedToolsMock.mockImplementation(async (input: unknown) => {
      const params = input as { senderIsOwner?: boolean };
      return {
        agentId: "main",
        tools:
          params.senderIsOwner === false
            ? [makeMessageTool()]
            : [makeMessageTool(), makeCronTool()],
      };
    });

    const resolve = createMcpToolCacheResolver(baseContext);
    const unknownFirst = await resolve({ senderIsOwner: undefined });
    const nonOwnerSecond = await resolve({ senderIsOwner: false });
    expect(unknownFirst.toolSchema.map((tool) => tool.name)).toContain("cron");
    expect(nonOwnerSecond.toolSchema.map((tool) => tool.name)).not.toContain("cron");

    const resolveSecond = createMcpToolCacheResolver(baseContext);
    const nonOwnerFirst = await resolveSecond({ senderIsOwner: false });
    const unknownSecond = await resolveSecond({ senderIsOwner: undefined });
    expect(nonOwnerFirst.toolSchema.map((tool) => tool.name)).not.toContain("cron");
    expect(unknownSecond.toolSchema.map((tool) => tool.name)).toContain("cron");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(4);
  });

  it("never reuses loopback tools across session permissions or effective exec modes", async () => {
    const resolve = createMcpToolCacheResolver();
    resolveGatewayScopedToolsMock.mockImplementation(async (input: unknown) => {
      const params = input as ScopedToolsCall;
      const unrestricted =
        params.execSession?.permissionMode === "full" || params.execOverrides?.mode === "full";
      return {
        agentId: "main",
        tools: unrestricted
          ? [makeMessageTool(), makeMockTool({ name: "exec" })]
          : [makeMessageTool()],
      };
    });

    const readOnly = await resolve({ execSession: { permissionMode: "read-only" } });
    const fullSession = await resolve({ execSession: { permissionMode: "full" } });
    const deniedOverride = await resolve({ execOverrides: { mode: "deny" } });
    const fullOverride = await resolve({ execOverrides: { mode: "full" } });

    expect(readOnly.toolSchema.map((tool) => tool.name)).not.toContain("exec");
    expect(fullSession.toolSchema.map((tool) => tool.name)).toContain("exec");
    expect(deniedOverride.toolSchema.map((tool) => tool.name)).not.toContain("exec");
    expect(fullOverride.toolSchema.map((tool) => tool.name)).toContain("exec");
    expect(await resolve({ execSession: { permissionMode: "read-only" } })).toBe(readOnly);
    expect(await resolve({ execOverrides: { mode: "deny" } })).toBe(deniedOverride);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(4);
  });

  it.each([["array", []]])(
    "rejects %s tool call arguments before hooks or execution",
    async (_label, badArguments) => {
      const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
        content: [{ type: "text", text: "EXECUTED" }],
      }));
      mockScopedTools([makeMessageTool({ execute })]);
      const { runtime, port } = await startLoopbackServerForTest();

      const response = await sendRaw({
        port,
        token: runtime.ownerToken,
        headers: jsonHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "message", arguments: badArguments },
        }),
      });

      expect(response.status).toBe(200);
      expect(await readMcpPayload(response)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32602,
          message: "Invalid params: tools/call arguments must be an object",
        },
      });
      expect(runBeforeToolCallHookMock).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("captures only successful calls with an explicit CLI capture key", async () => {
    const captureKey = "google-gemini-cli";
    const captured: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const blockedResults: unknown[] = [];
    const startedTargets: unknown[] = [];
    const finishedTargets: unknown[] = [];
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallStart: ({ args }) => {
        startedTargets.push(args.target);
        return typeof args.target === "string" ? args.target : undefined;
      },
      onToolCallFinish: ({ args }) => finishedTargets.push(args.target),
      onToolCallResult: (result) => {
        if (result.outcome === "blocked") {
          blockedResults.push({
            correlationId: result.correlationId,
            deniedReason: result.deniedReason,
          });
        } else if (result.toolName === "message" && result.args.action === "send") {
          captured.push({ toolName: result.toolName, args: result.args });
        }
      },
    });
    const { runtime } = await startLoopbackServerForTest();

    expect(
      (
        await sendLoopbackToolCall({
          token: runtime.ownerToken,
          name: "message",
          args: { action: "send", target: "chat123", message: "sent" },
          headers: captureHeaders(captureKey),
        })
      ).status,
    ).toBe(200);

    runBeforeToolCallHookMock.mockResolvedValueOnce({
      blocked: true,
      kind: "veto",
      reason: "blocked for test",
    });
    expect(
      (
        await sendLoopbackToolCall({
          token: runtime.ownerToken,
          name: "message",
          args: { action: "send", target: "blocked", message: "not sent" },
          headers: captureHeaders(captureKey),
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await sendLoopbackToolCall({
          token: runtime.ownerToken,
          name: "message",
          args: { action: "send", target: "implicit-main", message: "not captured" },
        })
      ).status,
    ).toBe(200);

    expect(captured).toEqual([
      expect.objectContaining({
        toolName: "message",
        args: { action: "send", target: "chat123", message: "sent" },
      }),
    ]);
    expect(startedTargets).toEqual(["chat123", "blocked"]);
    expect(finishedTargets).toEqual(["chat123", "blocked"]);
    expect(blockedResults).toEqual([
      { correlationId: "blocked", deniedReason: "plugin-before-tool-call" },
    ]);
  });

  it("preserves hook failure dispositions in CLI capture", async () => {
    const captureKey = "hook-failure-dispositions";
    const captured: unknown[] = [];
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallStart: ({ args }) => String(args.target),
      onToolCallResult: (result) => {
        captured.push({
          outcome: result.outcome,
          correlationId: result.correlationId,
          ...(result.outcome === "blocked" ? { deniedReason: result.deniedReason } : {}),
        });
      },
    });
    const { runtime } = await startLoopbackServerForTest();
    const cases = [
      { disposition: "failed" },
      { disposition: "cancelled" },
      { disposition: "timed_out" },
      { disposition: "blocked", deniedReason: "plugin-approval" },
    ] as const;

    for (const testCase of cases) {
      runBeforeToolCallHookMock.mockResolvedValueOnce({
        blocked: true,
        kind: "failure",
        disposition: testCase.disposition,
        ...(testCase.disposition === "blocked" ? { deniedReason: testCase.deniedReason } : {}),
        reason: "hook prevented execution",
      });
      const response = await sendLoopbackToolCall({
        token: runtime.ownerToken,
        name: "message",
        args: { action: "send", target: testCase.disposition, message: "not sent" },
        headers: captureHeaders(captureKey),
      });
      expect(response.status).toBe(200);
      expect((await readMcpPayload(response)).result?.isError).toBe(true);
    }

    expect(captured).toEqual([
      { outcome: "failed", correlationId: "failed" },
      { outcome: "cancelled", correlationId: "cancelled" },
      { outcome: "timed_out", correlationId: "timed_out" },
      {
        outcome: "blocked",
        correlationId: "blocked",
        deniedReason: "plugin-approval",
      },
    ]);
  });

  it("classifies resolved structured results for CLI capture", async () => {
    const captureKey = "structured-results";
    const captured: unknown[] = [];
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallStart: ({ args }) => String(args.status),
      onToolCallResult: (result) => {
        captured.push({
          outcome: result.outcome,
          correlationId: result.correlationId,
          ...(result.outcome === "blocked" ? { deniedReason: result.deniedReason } : {}),
        });
      },
    });
    mockScopedTools([
      makeMessageTool({
        execute: async (_toolCallId, args) => ({
          content: [{ type: "text", text: "result" }],
          details: args as Record<string, unknown>,
        }),
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();
    const cases = [
      { status: "completed", expected: "completed" },
      { status: "failed", expected: "failed" },
      { status: "blocked", expected: "blocked" },
      { status: "cancelled", expected: "cancelled" },
      { status: "completed-timeout", expected: "timed_out", timedOut: true },
    ] as const;

    for (const testCase of cases) {
      const response = await sendLoopbackToolCall({
        token: runtime.ownerToken,
        name: "message",
        args: {
          status: testCase.status === "completed-timeout" ? "completed" : testCase.status,
          ...("timedOut" in testCase && testCase.timedOut ? { timedOut: true } : {}),
        },
        headers: captureHeaders(captureKey),
      });
      expect(response.status).toBe(200);
      const payload = await readMcpPayload(response);
      expect(payload.result?.isError).toBe(testCase.expected !== "completed");
    }

    expect(captured).toEqual([
      { outcome: "completed", correlationId: "completed" },
      { outcome: "failed", correlationId: "failed" },
      {
        outcome: "blocked",
        correlationId: "blocked",
        deniedReason: "tool_result_blocked",
      },
      { outcome: "cancelled", correlationId: "cancelled" },
      { outcome: "timed_out", correlationId: "completed" },
    ]);
  });

  it("captures the finalized arguments after preparation and hook rewriting", async () => {
    const captureKey = "hook-rewritten-send";
    const updatedCalls = vi.fn();
    const finishedCalls = vi.fn();
    const captured = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallUpdate: updatedCalls,
      onToolCallFinish: finishedCalls,
      onToolCallResult: captured,
    });
    const prepared = { stage: "prepared", privateState: "preserved" };
    const prepare = vi.fn(async () => prepared);
    const finalize = vi.fn((hookParams: unknown, preparedParams: unknown) => {
      expect(hookParams).toEqual({ stage: "hook-adjusted" });
      expect(preparedParams).toBe(prepared);
      return { ...prepared, stage: "finalized" };
    });
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "EXECUTED" }],
    }));
    mockScopedTools([
      makeMessageTool({
        prepareBeforeToolCallParams: prepare,
        finalizeBeforeToolCallParams: finalize,
        execute,
      }),
    ]);
    runBeforeToolCallHookMock.mockImplementationOnce(async ({ params }) => {
      expect(params).toBe(prepared);
      return { blocked: false, params: { stage: "hook-adjusted" } };
    });
    const { runtime } = await startLoopbackServerForTest();
    const payload = await readOkMcpPayload(
      await sendLoopbackToolCall({
        token: runtime.ownerToken,
        name: "message",
        args: { stage: "raw" },
        headers: captureHeaders(captureKey),
      }),
    );
    const args = { stage: "finalized", privateState: "preserved" };
    expect(prepare).toHaveBeenCalledWith(
      { stage: "raw" },
      expect.objectContaining({
        toolCallId: expect.stringMatching(/^mcp-/),
        hookContext: expect.objectContaining({ sessionKey: "agent:main:main" }),
      }),
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^mcp-/),
      args,
      expect.any(AbortSignal),
    );
    expect(updatedCalls).toHaveBeenCalledWith({
      previous: { toolName: "message", args: { stage: "raw" } },
      current: { toolName: "message", args },
    });
    expect(finishedCalls).toHaveBeenCalledWith({ toolName: "message", args }, { prepared: true });
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "message", args, outcome: "completed" }),
    );
    expectMcpResultText(payload, "EXECUTED", false);
  });

  it("binds slow request bodies to their capture generation at header acceptance", async () => {
    const captureKey = "slow-request-generation";
    const requestClassified = vi.fn();
    const requestStarted = vi.fn();
    const captured = vi.fn();
    const { promise: requestStartedPromise, resolve: resolveRequestStarted } = createDeferred();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onRequestStart: () => {
        requestStarted();
        resolveRequestStarted?.();
      },
      onRequestClassified: requestClassified,
      onToolCallResult: captured,
    });
    const { runtime, port } = await startLoopbackServerForTest();
    const { req, response: responsePromise } = openMcpRequest({
      port,
      token: runtime.ownerToken,
      headers: { "transfer-encoding": "chunked", ...captureHeaders(captureKey) },
    });
    req.flushHeaders();
    void requestStartedPromise.then(() => {
      clearMcpLoopbackToolCallCapture(captureKey);
      req.end(mcpToolCallBody("message", { action: "send", target: "late-body" }));
    });

    await requestStartedPromise;
    expect(requestStarted).toHaveBeenCalledOnce();
    expect(requestClassified).not.toHaveBeenCalled();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(requestClassified).toHaveBeenCalledOnce();
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        args: { action: "send", target: "late-body" },
        outcome: "completed",
      }),
    );
  });

  it("waits through a quiet admission grace before clearing a failed-turn capture", async () => {
    const captureKey = "admission-grace";
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: vi.fn(),
    });
    const idlePromise = waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
      timeoutMs: 500,
      admissionGraceMs: 40,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey,
      toolName: "message",
      args: { action: "send", target: "late-admission" },
    });
    if (!captureHandle) {
      throw new Error("Expected late MCP capture admission");
    }
    setTimeout(() => markMcpLoopbackToolCallFinished(captureHandle), 10);

    await expect(idlePromise).resolves.toBe(true);
  });

  it("keeps capture observer errors from changing tool success", async () => {
    const captureKey = "throwing-observer";
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: () => {
        throw new Error("observer failed");
      },
    });
    const { runtime } = await startLoopbackServerForTest();

    const response = await sendLoopbackToolCall({
      token: runtime.ownerToken,
      name: "message",
      args: { action: "send", target: "chat123", message: "sent" },
      headers: captureHeaders(captureKey),
    });

    expect(response.status).toBe(200);
    const payload = await readMcpPayload(response);
    expect(payload.result?.isError).toBe(false);
  });

  it("captures partial-delivery errors before returning the tool failure", async () => {
    const captureKey = "partial-delivery";
    const captured = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: captured,
    });
    mockScopedTools([
      makeMessageTool({
        execute: async () => {
          throw Object.assign(new Error("second chunk failed"), { sentBeforeError: true });
        },
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();

    const response = await sendLoopbackToolCall({
      token: runtime.ownerToken,
      name: "message",
      args: { action: "send", target: "chat123", message: "sent partly" },
      headers: captureHeaders(captureKey),
    });

    const payload = await readMcpPayload(response);
    expect(payload.result?.isError).toBe(true);
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        outcome: "failed",
        result: expect.objectContaining({ sentBeforeError: true }),
      }),
    );
  });

  it("advertises and executes only readable tools while tolerating an unreadable description", async () => {
    const hiddenExecute = vi.fn<MockGatewayTool["execute"]>(async () => ({ content: [] }));
    const brokenName = makeMockTool();
    const hidden = makeMockTool({ name: "hidden", execute: hiddenExecute });
    const healthy = makeMessageTool();
    for (const [tool, field] of [
      [brokenName, "name"],
      [hidden, "parameters"],
      [healthy, "description"],
    ] as const) {
      Object.defineProperty(tool, field, {
        get() {
          throw new Error("unreadable plugin field");
        },
      });
    }
    mockScopedTools([brokenName, hidden, healthy]);
    const { runtime } = await startLoopbackServerForTest();
    const listed = await readOkMcpPayload(
      await sendLoopbackToolsList({ token: runtime.ownerToken }),
    );
    expect(listed.result?.tools).toEqual([{ name: "message", inputSchema: objectSchema({}) }]);
    expectMcpResultText(await callMainSessionTool({ token: runtime.ownerToken }), "ok");
    expectMcpResultText(
      await callMainSessionTool({ token: runtime.ownerToken, name: "hidden" }),
      "Tool not available: hidden",
      true,
    );
    expect(hiddenExecute).not.toHaveBeenCalled();
  });

  it("resolves legacy cron tools/call names to the renamed automations tool", async () => {
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "SCHEDULED" }],
    }));
    const tool = makeMockTool({ name: "automations", description: "manage schedules", execute });

    const payload = await handleMcpJsonRpc({
      message: { ...mcpToolCallMessage("cron"), params: { name: "cron" } },
      tools: [tool as unknown as AnyAgentTool],
      toolSchema: buildMockMcpToolSchema([tool]),
    });

    expectMcpResultText(payload as McpToolResultPayload, "SCHEDULED", false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.stringMatching(/^mcp-/), {}, undefined);
  });

  it("closes a pending startup once for concurrent shutdown callers", async () => {
    const starting = ensureMcpLoopbackServer();
    const closing = Promise.allSettled([closeMcpLoopbackServer(), closeMcpLoopbackServer()]);
    try {
      await starting;
      expect(await closing).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
    } finally {
      await closing;
      await closeMcpLoopbackServer();
    }
  });

  it("returns 401 when the bearer token is missing", async () => {
    const { port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      headers: { "content-type": "application/json" },
      body: mcpToolsListBody(),
    });
    expect(response.status).toBe(401);
  });

  it("returns 415 when the content type is not JSON", async () => {
    const { port } = await startLoopbackServerForTest();
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port,
      token: runtime?.ownerToken,
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(response.status).toBe(415);
  });

  it("returns JSON-RPC parse errors only for invalid JSON", async () => {
    const { port } = await startLoopbackServerForTest();
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port,
      token: runtime?.ownerToken,
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const payload = (await response.json()) as {
      id?: unknown;
      error?: { code?: number; message?: string };
    };

    expect(response.status).toBe(400);
    expect(payload.id).toBeNull();
    expect(payload.error).toMatchObject({
      code: -32700,
      message: "Parse error",
    });
  });

  it("does not include notifications in internal-error batch responses", async () => {
    resolveGatewayScopedToolsMock.mockImplementation(async () => {
      throw new Error("tool resolution exploded");
    });
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "tools/list" },
        { jsonrpc: "2.0", id: 42, method: "tools/list" },
      ]),
    });
    const payload = (await response.json()) as Array<{
      id?: unknown;
      error?: { code?: number; message?: string };
    }>;

    expect(response.status).toBe(500);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: 42,
      error: {
        code: -32603,
        message: "Internal error",
      },
    });
  });

  it("returns invalid request errors for malformed batch entries without resetting the request", async () => {
    const { port } = await startLoopbackServerForTest();
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port,
      token: runtime?.ownerToken,
      headers: { "content-type": "application/json" },
      body: `[null,${mcpToolsListBody(7)}]`,
    });
    const payload = (await response.json()) as Array<{
      id?: unknown;
      error?: { code?: number; message?: string };
      result?: { tools?: Array<{ name: string }> };
    }>;

    expect(response.status).toBe(200);
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request",
      },
    });
    expect(payload[1]?.id).toBe(7);
    expect(payload[1]?.result?.tools?.map((tool) => tool.name)).toContain("message");
  });

  it("returns an invalid request for an empty batch before harness policy", async () => {
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:harness:codex:supervision:native-thread",
      },
      body: "[]",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
  });

  it("suppresses internal errors for notification-only requests", async () => {
    resolveGatewayScopedToolsMock.mockImplementation(async () => {
      throw new Error("tool resolution exploded");
    });
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
    });

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);
  });

  it("dispatches tools/call notifications without returning a response", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    mockScopedTools([makeMessageTool({ execute })]);
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "message", arguments: { body: "hello" } },
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps delayed valid MCP request bodies open when timeout config exceeds Node's timer ceiling", async () => {
    const previousTimeout = process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS;
    process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS = "2147483648";
    try {
      const { port, runtime } = await startLoopbackServerForTest();
      const response = await sendDelayedBody({
        port,
        token: runtime.ownerToken,
        body: mcpToolsListBody(),
        delayMs: 25,
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        result: { tools: [{ name: "message" }] },
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it.each(["declared-size", "timeout", "disconnect", "pipeline"] as const)(
    "preserves body admission and capture cleanup over real HTTP: %s",
    async (mode) => {
      vi.stubEnv(
        "OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS",
        mode === "timeout" || mode === "declared-size" ? "30" : "30000",
      );
      const captureKey = `body-lifecycle-${mode}`;
      const events: string[] = [];
      const admitted = createDeferred();
      const finished = createDeferred();
      const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
      mockScopedTools([makeMessageTool({ execute })]);
      beginMcpLoopbackToolCallCapture({
        captureKey,
        onRequestStart: () => {
          events.push("start");
          admitted.resolve();
        },
        onRequestClassified: () => events.push("classified"),
        onRequestFinish: () => {
          events.push("finish");
          finished.resolve();
        },
        onToolCallResult: () => events.push("result"),
      });
      const { runtime, port } = await startLoopbackServerForTest();
      const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
      const received: Buffer[] = [];
      let captureFinishedAtPeerEnd = false;
      const socketErrors: string[] = [];
      socket.on("error", (error) => socketErrors.push(error.message));
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("end", () => {
        captureFinishedAtPeerEnd = events.includes("finish");
        socket.end();
      });
      const closed = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      const headers = (framing: string) =>
        `POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${runtime.ownerToken}\r\nContent-Type: application/json\r\nX-OpenClaw-Cli-Capture-Key: ${captureKey}\r\n${framing}\r\n\r\n`;
      const call = Buffer.from(mcpToolCallBody("message", { text: "🦞" }));
      try {
        if (mode === "declared-size") {
          socket.write(headers("Content-Length: 1048577"));
        } else if (mode === "timeout") {
          socket.write(headers("Transfer-Encoding: chunked") + "1\r\n{\r\n");
        } else if (mode === "disconnect") {
          socket.write(headers("Content-Length: 100"));
          await admitted.promise;
          socket.destroy();
        } else {
          const oversized = "x".repeat(1_048_577);
          socket.write(
            headers("Transfer-Encoding: chunked") +
              `${oversized.length.toString(16)}\r\n${oversized}\r\n0\r\n\r\n` +
              headers(`Content-Length: ${call.length}\r\nConnection: close`) +
              call.toString(),
          );
        }
        await expectPromiseResolvesWithin(closed, 2_000, "body probe socket close");
        await expectPromiseResolvesWithin(finished.promise, 500, "body probe capture finish");
        const wire = Buffer.concat(received).toString();
        const statuses = [...wire.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((match) =>
          Number(match[1]),
        );
        expect(socketErrors).toEqual([]);
        expect(events.filter((event) => event === "start").length).toBeGreaterThan(0);
        expect(events.filter((event) => event === "finish")).toHaveLength(
          events.filter((event) => event === "start").length,
        );
        expect(events.filter((event) => event === "classified")).toHaveLength(
          events.filter((event) => event === "start").length,
        );
        expect(
          await waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
            timeoutMs: 100,
            admissionGraceMs: 0,
          }),
        ).toBe(true);
        expect(execute).not.toHaveBeenCalled();
        if (mode !== "disconnect") {
          expect(captureFinishedAtPeerEnd).toBe(true);
          const status = mode === "timeout" ? 408 : 413;
          expect(statuses).toEqual([status]);
          expect(wire).toContain(
            JSON.stringify({
              error: status === 413 ? "payload_too_large" : "request_body_timeout",
            }),
          );
        }
      } finally {
        socket.destroy();
        await closed;
        clearMcpLoopbackToolCallCapture(captureKey);
        vi.unstubAllEnvs();
      }
    },
  );

  it("rejects non-loopback origins even without fetch metadata", async () => {
    await expectBrowserToolsListStatus({
      origin: "https://evil.example",
      token: "none",
      status: 403,
    });
  });

  it("allows cross-site fetch metadata when both ends are loopback (localhost ↔ 127.0.0.1)", async () => {
    // Browsers report a request from a `http://localhost:<ui-port>`
    // page to `http://127.0.0.1:<mcp-port>` as Sec-Fetch-Site:
    // cross-site even though both ends are loopback. The gate must
    // not blanket-reject on the cross-site signal — checkBrowserOrigin
    // already authorizes loopback origins from loopback peers via
    // its `local-loopback` matcher.
    await expectBrowserToolsListStatus({
      origin: "http://localhost:43123",
      fetchSite: "cross-site",
      status: 200,
    });
  });
});

/**
 * The admission gate keys on the run id `resolveMcpRequestContext` copies out of
 * a run-bound CLI client grant, and the resolver tests can only assert that
 * premise. These drive the real loopback server with the real resolver, so the
 * attach branch's missing run id and the grant liveness re-check are produced
 * rather than supplied: an `openclaw attach` grant for the collector's own child
 * session, and the collector's own grant revoked or rebound inside the awaited
 * before-tool hook.
 */
describe("collector result tool across the loopback MCP boundary", () => {
  const collectorRunId = "mcp-boundary-collector-run";
  const collectorSessionKey = "agent:main:subagent:mcp-boundary-collector";
  const captureKey = "capture-collector-boundary";
  const collectorSchema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };

  useMcpCollectorRegistry({
    runId: collectorRunId,
    childSessionKey: collectorSessionKey,
    outputSchema: collectorSchema,
  });

  beforeEach(async () => {
    const { resolveGatewayScopedTools: resolveActual } =
      await vi.importActual<typeof import("./tool-resolution.js")>("./tool-resolution.js");
    resolveGatewayScopedToolsMock.mockImplementation(
      async (...args) =>
        (await resolveActual(
          ...(args as Parameters<typeof resolveActual>),
        )) as MockGatewayScopedTools,
    );
  });

  async function mintCollectorGrant() {
    const grant = await createCliGrant(collectorRunId, {
      context: {
        sessionKey: collectorSessionKey,
        agentId: "main",
        senderIsOwner: false,
        runId: collectorRunId,
      },
      captureKey,
    });
    return grant.scope;
  }

  async function listToolNames(scope: { token: string; headers?: Record<string, string> }) {
    const payload = await readOkMcpPayload(await sendLoopbackToolsList(scope));
    return (payload.result?.tools ?? []).map((tool) => tool.name);
  }

  async function callStructuredOutput(scope: { token: string; headers?: Record<string, string> }) {
    return await readOkMcpPayload(
      await sendLoopbackToolCall({
        ...scope,
        name: "structured_output",
        args: { result: { answer: "ok" } },
      }),
    );
  }

  function expectNothingRecorded(runId = collectorRunId) {
    const entry = getSubagentRunByRunId(runId);
    expect(entry?.structuredOutput).toBeUndefined();
    expect(entry?.collectorCompletion).toBeUndefined();
  }

  it("gives an attach grant on the collector's session no result tool to list or call", async () => {
    await startLoopbackServerForTest();
    const attach = mintAttachGrant({ sessionKey: collectorSessionKey, agentId: "main" });
    const scope = { token: attach.token };

    const names = await listToolNames(scope);
    expect(names).not.toContain("structured_output");
    expect(names).toContain("sessions_yield");

    expectMcpResultText(
      await callStructuredOutput(scope),
      "Tool not available: structured_output",
      true,
    );
    expectNothingRecorded();
  });

  it("refuses the collector's own call when the record stops owning the admitted run", async () => {
    const reboundRunId = "mcp-boundary-collector-rebound";
    await startLoopbackServerForTest();
    const scope = await mintCollectorGrant();
    expect(await listToolNames(scope)).toContain("structured_output");

    runBeforeToolCallHookMock.mockImplementation(async (args: { params: unknown }) => {
      // Grant liveness is untouched, so this reaches the pre-persistence re-check.
      await mutateSubagentRuns([collectorRunId, reboundRunId], (rows) => {
        const entry = expectDefined(rows.get(collectorRunId), "collector run");
        return {
          value: undefined,
          postimages: new Map<string, SubagentRunRecord | null>([
            [collectorRunId, null],
            [reboundRunId, { ...entry, runId: reboundRunId, swarmRunId: reboundRunId }],
          ]),
        };
      });
      return { blocked: false, params: args.params };
    });

    expectMcpResultText(
      await callStructuredOutput(scope),
      "Failed to persist structured_output: caller no longer owns the admitted collector run",
      true,
    );
    expectNothingRecorded(reboundRunId);
  });

  it("records the result for the collector's own run-bound grant", async () => {
    await startLoopbackServerForTest();
    const scope = await mintCollectorGrant();

    expectMcpResultText(
      await callStructuredOutput(scope),
      JSON.stringify({ status: "recorded" }, null, 2),
    );
    expect(getSubagentRunByRunId(collectorRunId)?.structuredOutput).toEqual({
      structured: { answer: "ok" },
      invalidAttempts: 0,
    });
  });
});

describe("createMcpLoopbackServerConfig", () => {
  it("requires an active matching CLI capture on GET and DELETE", async () => {
    const { port, runtime } = await startLoopbackServerForTest();
    const captureKey = "capture-transport";
    const grant = await createCliGrant("run-transport", {
      context: { sessionKey: "agent:main:transport", senderIsOwner: false },
      captureKey,
    });
    const send = async (method: "GET" | "DELETE", requestCaptureKey?: string) =>
      await sendRaw({
        port,
        method,
        token: grant.token,
        headers: requestCaptureKey ? { "x-openclaw-cli-capture-key": requestCaptureKey } : {},
      });

    for (const method of ["GET", "DELETE"] as const) {
      for (const requestCaptureKey of [undefined, "capture-forged"]) {
        const response = await send(method, requestCaptureKey);
        expect(response.status).toBe(401);
        await response.body?.cancel();
      }
    }

    const getResponse = await send("GET", captureKey);
    expect(getResponse.status).toBe(200);
    await expectInitialSseCommentFrame(getResponse);
    expect((await send("DELETE", captureKey)).status).toBe(200);

    deactivateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey,
    });
    for (const method of ["GET", "DELETE"] as const) {
      const response = await send(method, captureKey);
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
  });

  it("withdraws a closing runtime before drain without fencing its successor", async () => {
    await ensureMcpLoopbackServer();
    const oldRuntime = getActiveMcpLoopbackRuntime();
    if (!oldRuntime) {
      throw new Error("expected old MCP loopback runtime");
    }
    // Node only exempts a connection from close()'s idle sweep once its parser has
    // begun a message, so the drain is pinned by the server-side request start, not
    // by the client-side connect. Capture admission is that server-side signal.
    const captureKey = "capture-stalled-drain";
    const {
      promise: requestStarted,
      resolve: resolveRequestStarted,
      reject: rejectRequestStarted,
    } = createDeferred();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onRequestStart: () => resolveRequestStarted(),
      onToolCallResult: vi.fn(),
    });
    const { req: stalledRequest, response: responsePromise } = openMcpRequest({
      port: oldRuntime.port,
      token: oldRuntime.ownerToken,
      headers: { connection: "close", ...captureHeaders(captureKey) },
    });
    stalledRequest.once("error", rejectRequestStarted);
    stalledRequest.write("{");
    let stalledRequestEnded = false;
    const finishStalledRequest = () => {
      if (stalledRequestEnded) {
        return;
      }
      stalledRequestEnded = true;
      stalledRequest.end("}");
    };
    let oldClose: Promise<void> | undefined;
    try {
      await requestStarted;

      let closeSettled = false;
      oldClose = closeMcpLoopbackServer().finally(() => {
        closeSettled = true;
      });
      expect(getActiveMcpLoopbackRuntime()).toBeUndefined();

      const successor = await startLoopbackServerForTest();
      const successorGrant = await createCliGrant("run-successor", {
        context: { sessionKey: "agent:main:successor", senderIsOwner: false },
        captureKey: "capture-successor",
      });
      // The unfinished body still holds the old connection, so the successor was
      // minted mid-drain: exactly the window where a late close could fence it.
      expect(closeSettled).toBe(false);

      finishStalledRequest();
      await responsePromise;
      await oldClose;
      expect(getActiveMcpLoopbackRuntime()?.ownerToken).toBe(successor.runtime.ownerToken);
      expect(
        (
          await sendRaw({
            port: successor.port,
            token: successorGrant.token,
            headers: jsonHeaders({ "x-openclaw-cli-capture-key": "capture-successor" }),
            body: mcpToolsListBody(),
          })
        ).status,
      ).toBe(200);
    } finally {
      clearMcpLoopbackToolCallCapture(captureKey);
      finishStalledRequest();
      await responsePromise.catch(() => undefined);
      await (oldClose ?? closeMcpLoopbackServer()).catch(() => undefined);
    }
  });

  it("rejects unsupported methods with 405 advertising GET, POST, DELETE", async () => {
    const { port } = await startLoopbackServerForTest();
    const res = await sendRaw({ port, method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST, DELETE");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

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
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
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
import { filterToolsByPolicy } from "../agents/tool-policy-match.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
} from "../infra/system-events.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
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
import {
  angleSchema,
  buildMockMcpToolSchema,
  createMcpToolCacheResolver,
  expectMcpResultText,
  expectMcpToolNames,
  jsonHeaders,
  makeCronTool,
  makeMessageTool,
  makeMockTool,
  mcpToolsListBody,
  objectSchema,
  mcpToolCallBody,
  mcpToolCallMessage,
  readMcpPayload,
  readOkMcpPayload,
  sendLoopbackToolCall,
  sendRaw,
  startLoopbackServerForTest,
  type McpToolResultPayload,
  type MockGatewayTool,
  type MockGatewayScopedTools,
} from "./mcp-http.test-support.js";

const MAIN_SESSION_HEADER = { "x-session-key": "agent:main:main" };
const ANGLE_NUMBER_PROPERTY = { type: "number" };

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

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
    toolPolicyConfig: options.toolPolicyConfig ?? getRuntimeConfigMock(),
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

async function callTool(params: Parameters<typeof sendLoopbackToolCall>[0]) {
  return readOkMcpPayload(await sendLoopbackToolCall(params));
}

async function listTools(params: Parameters<typeof sendLoopbackToolsList>[0]) {
  return readOkMcpPayload(await sendLoopbackToolsList(params));
}

async function expectStatus(response: Promise<Response>, status = 200) {
  expect((await response).status).toBe(status);
}

function capturedMessage(token: string, captureKey: string) {
  return (args: Record<string, unknown>, captured = true) =>
    sendLoopbackToolCall({
      token,
      name: "message",
      args,
      ...(captured ? { headers: captureHeaders(captureKey) } : {}),
    });
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

function mockScopedTools(tools: MockGatewayTool[], workspaceDir?: string) {
  resolveGatewayScopedToolsMock.mockResolvedValue({
    agentId: "main",
    tools,
    ...(workspaceDir === undefined ? {} : { workspaceDir }),
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
    const angle = angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"]);
    for (const [name, variants, required] of [
      ["fuzzplugin_move_delta", [angleSchema(null, ["angle"]), angle], ["angle"]],
      ["fuzzplugin_optional_delta", [angle, true], []],
      ["fuzzplugin_boolean_delta", [angleSchema(false), angle], []],
    ] as const) {
      expect(
        buildMockMcpToolSchema([makeMockTool({ name, parameters: { anyOf: variants } })])[0]
          ?.inputSchema,
      ).toEqual(angleSchema(ANGLE_NUMBER_PROPERTY, [...required]));
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
      const payload = await listTools({
        token: runtime.ownerToken,
        headers: {
          ...MAIN_SESSION_HEADER,
          "x-openclaw-current-message-id": `message-${index}`,
        },
      });
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

  it("binds a CLI grant's authority context and ignores spoofed scope headers", async () => {
    await startLoopbackServerForTest();
    const admittedRunContext = await activeAdmission("run-bound");
    let caller: ReturnType<typeof getGatewayToolCallerIdentity>;
    mockScopedTools(
      [
        makeMessageTool({
          execute: async () => {
            caller = getGatewayToolCallerIdentity();
            return textResult("ok");
          },
        }),
      ],
      "/tmp/openclaw-workspace",
    );
    const context = {
      sessionKey: "agent:main:discord:channel:bound",
      runtimePolicySessionKey: "agent:worker:discord:default:direct:bound-user",
      runtimePolicyAgentId: "worker",
      agentId: "main",
      sessionId: "session-bound",
      runId: "run-bound",
      requesterOrigin: {
        sessionKey: "agent:main:telegram:direct:42",
        messageProvider: "telegram",
        accountId: "requester-account",
        chatType: "direct",
        conversationId: "42",
        senderId: "alice",
      },
      messageProvider: "discord",
      currentChannelId: "discord:bound",
      currentThreadTs: "bound-thread",
      accountId: "bound-account",
      senderIsOwner: false,
      nodeExecAllowed: true,
      requireExplicitMessageTarget: true,
      sourceReplyOnly: true,
      nativeCronCreatorToolAllowlist: ["read", "exec"],
      delegationCapability: "report_only",
      toolsAllow: ["message"],
      approvalReviewerDeviceId: "bound-reviewer",
      execOverrides: { host: "node", security: "allowlist", ask: "always", node: "mac-b" },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    } satisfies McpLoopbackRequestContext;
    const grant = await createCliGrant("run-bound", {
      context,
      admittedRunContext,
      captureKey: "capture-bound",
    });
    expect(grant.capture.captureNativeToolAuthority(context.nativeCronCreatorToolAllowlist)).toBe(
      true,
    );
    const headers = {
      "x-session-key": "agent:main:spoofed",
      "x-openclaw-session-id": "spoofed",
      "x-openclaw-message-channel": "telegram",
      "x-openclaw-account-id": "victim",
      "x-openclaw-client-caps": "admin",
      "x-openclaw-sender-is-owner": "true",
      "x-openclaw-source-reply-only": "false",
      "x-openclaw-require-explicit-message-target": "false",
    };
    for (const captureKey of [undefined, "capture-forged"]) {
      await expectStatus(
        sendLoopbackToolsList({
          token: grant.token,
          headers: { ...headers, ...(captureKey ? captureHeaders(captureKey) : {}) },
        }),
        401,
      );
    }
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
    expectMcpToolNames(
      await listTools({
        ...grant.scope,
        headers: { ...headers, ...grant.scope.headers },
      }),
      ["message"],
    );
    expectMcpResultText(
      await callTool({
        ...grant.scope,
        headers: { ...headers, ...grant.scope.headers },
        name: "message",
      }),
      "ok",
    );
    const { runId: _runId, toolsAllow: _toolsAllow, ...resolvedContext } = context;
    expect(getScopedToolsCall(0)).toMatchObject({
      ...resolvedContext,
      surface: "loopback",
      includeNodeExecTool: true,
    });
    expect(Array.from(getScopedToolsCall(0).excludeToolNames ?? [])).not.toContain("exec");
    expect(getBeforeToolCallHookInput(0).ctx).toMatchObject({
      sessionKey: context.sessionKey,
      runId: context.runId,
      approvalReviewerDeviceId: context.approvalReviewerDeviceId,
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(caller).toMatchObject({
      sessionKey: context.sessionKey,
      requesterOrigin: context.requesterOrigin,
      operationalRunInstance: admittedRunContext.operationalRunInstance,
      turnSourceChannel: context.messageProvider,
      turnSourceTo: context.currentChannelId,
      turnSourceAccountId: context.accountId,
      turnSourceThreadId: context.currentThreadTs,
    });
  });

  it("allows native discovery but denies calls until the current turn observes its tools", async () => {
    getRuntimeConfigMock.mockReturnValue({ session: { mainKey: "main" } });
    const execute = vi.fn(async (nativeTools: readonly string[] | null | undefined) =>
      textResult(JSON.stringify(nativeTools)),
    );
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

    expectMcpToolNames(await listTools(requestScope), ["message"]);
    const response = await sendLoopbackToolCall({ ...requestScope, name: "message" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      error: { code: -32000, message: expect.stringMatching(/retry|wait|initializ/i) },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(capture.captureNativeToolAuthority(["read"])).toBe(true);
    expectMcpResultText(await callTool({ ...requestScope, name: "message" }), '["read"]');
    expect(capture.captureNativeToolAuthority([])).toBe(true);
    expectMcpResultText(await callTool({ ...requestScope, name: "message" }), "[]");
    expect(capture.captureNativeToolAuthority(null)).toBe(true);
    expect(
      await (await sendLoopbackToolCall({ ...requestScope, name: "message" })).json(),
    ).toMatchObject({
      error: { code: -32000 },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps admitted CLI tool policy across config publication while new grants use current policy", async () => {
    const initial = { session: { mainKey: "main" }, tools: { deny: ["sessions_list"] } };
    const updated = { session: { mainKey: "main" }, tools: { deny: ["message"] } };
    getRuntimeConfigMock.mockReturnValue(initial);
    resolveGatewayScopedToolsMock.mockImplementation(async () => {
      const scoped = getScopedToolsCall(resolveGatewayScopedToolsMock.mock.calls.length - 1);
      return {
        agentId: "main",
        tools: filterToolsByPolicy(
          [makeMessageTool(), makeMockTool({ name: "sessions_list" })],
          scoped.cfg.tools,
        ),
      };
    });
    await startLoopbackServerForTest();
    const first = await createCliGrant("policy-before", { toolPolicyConfig: initial });
    const names = async (scope: typeof first.scope) => {
      const payload = await listTools(scope);
      return payload.result?.tools?.map((tool) => tool.name);
    };
    expect(await names(first.scope)).toEqual(["message"]);

    getRuntimeConfigMock.mockReturnValue(updated);
    initial.tools.deny.push("message");
    expect(await names(first.scope)).toEqual(["message"]);
    expectMcpResultText(await callTool({ ...first.scope, name: "message" }), "ok");
    const next = await createCliGrant("policy-after", { toolPolicyConfig: updated });
    expect(await names(next.scope)).toEqual(["sessions_list"]);
    expect(first).not.toHaveProperty("toolPolicyConfig");
    expect(first.context).not.toHaveProperty("toolPolicyConfig");
  });

  it("keeps prepared auth stores isolated between CLI grants", async () => {
    await startLoopbackServerForTest();
    const authStore = (name: string): AuthProfileStore => ({
      version: 1,
      profiles: {
        [`xai:${name}`]: { type: "token", provider: "xai", token: `${name}-token` },
      },
    });
    const firstStore = authStore("first");
    const secondStore = authStore("second");
    const firstGrant = await createCliGrant("run-auth-/agents/first", {
      captureKey: "capture-first",
      toolAuth: { agentDir: "/agents/first", store: firstStore },
    });
    const secondGrant = await createCliGrant("run-auth-/agents/second", {
      captureKey: "capture-second",
      toolAuth: { agentDir: "/agents/second", store: secondStore },
    });
    await expectStatus(sendLoopbackToolsList(firstGrant.scope));
    await expectStatus(sendLoopbackToolsList(secondGrant.scope));

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
    const execute = vi.fn(async () => textResult("should not execute"));
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
    await expectStatus(responsePromise, 401);
    expect(changed).toBe(true);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(resolverCallsBeforeBody);
    clearMcpLoopbackToolCallCapture(captureKey);
    await expectStatus(
      sendLoopbackToolsList({
        token: grant.token,
        headers: captureHeaders(captureKey),
      }),
    );
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
    await expectStatus(response, 401);
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
          return textResult("published");
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
    resolveGatewayScopedToolsMock.mockImplementation(async (input) => ({
      agentId: "main",
      tools: [
        makeMockTool({
          name: "sessions_yield",
          execute: async (_id, args) => {
            const { onYield } = input as ScopedToolsCall;
            const { message, acknowledgment } = args as { message: string; acknowledgment: string };
            if (!onYield) {
              throw new Error("Yield not supported");
            }
            await onYield(message, acknowledgment);
            return textResult("yielded");
          },
        }),
      ],
    }));
    const { runtime } = await startLoopbackServerForTest();
    const first = vi.fn(),
      second = vi.fn();
    for (const [message, acknowledgment, onYield] of [
      ["first yield", "First wait", first],
      ["second yield", "Second wait", second],
    ] as const) {
      beginMcpLoopbackToolCallCapture({
        captureKey: "capture-reused",
        onYield,
        onToolCallResult: vi.fn(),
      });
      expectMcpResultText(
        await callTool({
          token: runtime.ownerToken,
          name: "sessions_yield",
          args: { message, acknowledgment },
          headers: {
            ...MAIN_SESSION_HEADER,
            "x-openclaw-session-id": "session-reused",
            ...captureHeaders("capture-reused"),
          },
        }),
        "yielded",
      );
    }
    expect(first).toHaveBeenCalledExactlyOnceWith("first yield", "First wait");
    expect(second).toHaveBeenCalledExactlyOnceWith("second yield", "Second wait");
  });

  it.each([false, undefined])(
    "separates loopback cache ownership starting with %s",
    async (first) => {
      resolveGatewayScopedToolsMock.mockImplementation(async (input) => ({
        agentId: "main",
        tools:
          (input as ScopedToolsCall).senderIsOwner === false
            ? [makeMessageTool()]
            : [makeMessageTool(), makeCronTool()],
      }));
      const resolve = createMcpToolCacheResolver();
      for (const senderIsOwner of [first, first === false ? undefined : false]) {
        const result = await resolve({ senderIsOwner });
        expect(result.toolSchema.map((tool) => tool.name).includes("cron")).toBe(
          senderIsOwner !== false,
        );
      }
      expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
    },
  );

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
      const execute = vi.fn<MockGatewayTool["execute"]>(async () => textResult("EXECUTED"));
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
    const send = capturedMessage(runtime.ownerToken, captureKey);
    await expectStatus(send({ action: "send", target: "chat123", message: "sent" }));

    runBeforeToolCallHookMock.mockResolvedValueOnce({
      blocked: true,
      kind: "veto",
      reason: "blocked for test",
    });
    await expectStatus(send({ action: "send", target: "blocked", message: "not sent" }));
    await expectStatus(
      send({ action: "send", target: "implicit-main", message: "not captured" }, false),
    );

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

  it.each(["failed", "blocked"] as const)(
    "captures the %s hook disposition",
    async (disposition) => {
      const captured = vi.fn();
      beginMcpLoopbackToolCallCapture({
        captureKey: "hook-disposition",
        onToolCallResult: captured,
      });
      runBeforeToolCallHookMock.mockResolvedValueOnce({
        blocked: true,
        kind: "failure",
        disposition,
        reason: "hook prevented execution",
        ...(disposition === "blocked" ? { deniedReason: "plugin-approval" } : {}),
      });
      const { runtime } = await startLoopbackServerForTest();
      const payload = await callTool({
        token: runtime.ownerToken,
        name: "message",
        headers: captureHeaders("hook-disposition"),
      });
      expect(payload.result?.isError).toBe(true);
      expect(captured).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: disposition,
          ...(disposition === "blocked" ? { deniedReason: "plugin-approval" } : {}),
        }),
      );
    },
  );

  it.each([
    ["completed", { status: "completed" }],
    ["timed_out", { status: "completed", timedOut: true }],
    ["blocked", { status: "blocked" }],
  ] as const)("captures the %s result branch", async (outcome, details) => {
    const captured = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey: "structured-results",
      onToolCallStart: () => "correlation",
      onToolCallResult: captured,
    });
    mockScopedTools([
      makeMessageTool({ execute: async () => ({ ...textResult("result"), details }) }),
    ]);
    const { runtime } = await startLoopbackServerForTest();
    const payload = await callTool({
      token: runtime.ownerToken,
      name: "message",
      headers: captureHeaders("structured-results"),
    });
    expect(payload.result?.isError).toBe(outcome !== "completed");
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome,
        correlationId: "correlation",
        ...(outcome === "blocked" ? { deniedReason: "tool_result_blocked" } : {}),
      }),
    );
  });

  it("captures the finalized arguments after preparation and hook rewriting", async () => {
    const captureKey = "hook-rewritten-send";
    const updated = vi.fn(),
      finished = vi.fn(),
      captured = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallUpdate: updated,
      onToolCallFinish: finished,
      onToolCallResult: captured,
    });
    const prepared = { stage: "prepared", privateState: "preserved" };
    mockScopedTools([
      makeMessageTool({
        prepareBeforeToolCallParams: async () => prepared,
        finalizeBeforeToolCallParams: (hookParams, preparedParams) => {
          expect(hookParams).toEqual({ stage: "hook-adjusted" });
          expect(preparedParams).toBe(prepared);
          return { ...prepared, stage: "finalized" };
        },
        execute: async (_id, args) => textResult(JSON.stringify(args)),
      }),
    ]);
    runBeforeToolCallHookMock.mockImplementationOnce(async ({ params }) => {
      expect(params).toBe(prepared);
      return { blocked: false, params: { stage: "hook-adjusted" } };
    });
    const { runtime } = await startLoopbackServerForTest();
    const payload = await callTool({
      token: runtime.ownerToken,
      name: "message",
      args: { stage: "raw" },
      headers: captureHeaders(captureKey),
    });
    const args = { stage: "finalized", privateState: "preserved" };
    expectMcpResultText(payload, JSON.stringify(args), false);
    expect(updated).toHaveBeenCalledWith({
      previous: { toolName: "message", args: { stage: "raw" } },
      current: { toolName: "message", args },
    });
    expect(finished).toHaveBeenCalledWith({ toolName: "message", args }, { prepared: true });
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "message", args, outcome: "completed" }),
    );
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

  it("bounds capture draining by elapsed time after a wall-clock rollback", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const captureKey = "clock-rollback";
    beginMcpLoopbackToolCallCapture({ captureKey, onToolCallResult: vi.fn() });
    markMcpLoopbackToolCallStarted({ captureKey, toolName: "message", args: {} });
    const settled = vi.fn();
    const idle = waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
      timeoutMs: 120,
    }).then(settled);
    try {
      vi.setSystemTime(Date.now() - 60_000);
      await vi.advanceTimersByTimeAsync(119);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith(false);
    } finally {
      clearMcpLoopbackToolCallCapture(captureKey);
      await idle;
      vi.useRealTimers();
    }
  });

  it("returns when admitted calls settle without waiting for new arrivals", async () => {
    vi.useFakeTimers();
    const captureKey = "admitted-request-drain";
    beginMcpLoopbackToolCallCapture({ captureKey, onToolCallResult: vi.fn() });
    const call = markMcpLoopbackToolCallStarted({ captureKey, toolName: "message", args: {} });
    const settled = vi.fn();
    const idle = waitForMcpLoopbackToolCallCaptureIdle(captureKey, { timeoutMs: 500 }).then(
      (result) => {
        settled(result);
        return result;
      },
    );
    try {
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      markMcpLoopbackToolCallFinished(call);
      await expect(idle).resolves.toBe(true);
    } finally {
      clearMcpLoopbackToolCallCapture(captureKey);
      vi.useRealTimers();
    }
  });

  it("keeps capture observer errors from changing tool success", async () => {
    beginMcpLoopbackToolCallCapture({
      captureKey: "throwing-observer",
      onToolCallResult: () => {
        throw new Error("observer failed");
      },
    });
    const { runtime } = await startLoopbackServerForTest();
    expectMcpResultText(
      await callTool({
        token: runtime.ownerToken,
        name: "message",
        headers: captureHeaders("throwing-observer"),
      }),
      "ok",
      false,
    );
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

  it("resolves legacy cron tools/call names to the renamed automations tool", async () => {
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => textResult("SCHEDULED"));
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

  it.each<
    [
      name: string,
      authenticated: boolean,
      headers: Record<string, string>,
      status: number,
      body?: string,
      method?: "PUT",
    ]
  >([
    ["missing bearer", false, {}, 401],
    ["non-JSON content type", true, { "content-type": "text/plain" }, 415, "{}"],
    ["mixed-case JSON content type", true, { "content-type": "Application/JSON" }, 200],
    ["mixed-case non-JSON content type", true, { "content-type": "Application/XML" }, 415],
    ["non-loopback origin before authentication", false, { origin: "https://evil.example" }, 403],
    [
      "cross-site localhost to loopback",
      true,
      { origin: "http://localhost:43123", "sec-fetch-site": "cross-site" },
      200,
    ],
    ["unsupported method", false, {}, 405, undefined, "PUT"],
  ])(
    "validates HTTP admission: %s",
    async (_name, authenticated, headers, status, body, method) => {
      const { port, runtime } = await startLoopbackServerForTest();
      const response = await sendRaw({
        port,
        token: authenticated ? runtime.ownerToken : undefined,
        headers: jsonHeaders(headers),
        body: method ? undefined : (body ?? mcpToolsListBody()),
        method,
      });
      expect(response.status).toBe(status);
      if (status === 405) {
        expect(response.headers.get("allow")).toBe("GET, POST, DELETE");
      }
    },
  );

  it.each<{
    name: string;
    body: string;
    status: number;
    headers: Record<string, string>;
    expected: Record<string, unknown> | Record<string, unknown>[];
  }>([
    {
      name: "invalid JSON",
      body: "{",
      status: 400,
      headers: {},
      expected: { id: null, error: { code: -32700, message: "Parse error" } },
    },
    {
      name: "malformed batch entry alongside a valid request",
      body: `[null,${mcpToolsListBody(7)}]`,
      status: 200,
      headers: {},
      expected: [
        { id: null, error: { code: -32600, message: "Invalid Request" } },
        {
          id: 7,
          result: { tools: expect.arrayContaining([expect.objectContaining({ name: "message" })]) },
        },
      ],
    },
    {
      name: "empty batch before harness policy",
      body: "[]",
      status: 200,
      headers: { "x-session-key": "agent:main:harness:codex:supervision:native-thread" },
      expected: { id: null, error: { code: -32600, message: "Invalid Request" } },
    },
  ])("returns protocol errors for $name", async ({ body, status, headers, expected }) => {
    const { port, runtime } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: jsonHeaders(headers),
      body,
    });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject(expected);
    if (body === "[]") {
      expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "suppresses notifications in internal errors with batch=%s",
    async (batch) => {
      resolveGatewayScopedToolsMock.mockImplementation(async () => {
        throw new Error("tool resolution exploded");
      });
      const { runtime, port } = await startLoopbackServerForTest();
      const response = await sendRaw({
        port,
        token: runtime.ownerToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          batch
            ? [
                { jsonrpc: "2.0", method: "tools/list" },
                { jsonrpc: "2.0", id: 42, method: "tools/list" },
              ]
            : { jsonrpc: "2.0", method: "tools/list" },
        ),
      });
      expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(batch ? 500 : 202);
      if (batch) {
        expect(await response.json()).toEqual([
          { jsonrpc: "2.0", id: 42, error: { code: -32603, message: "Internal error" } },
        ]);
      } else {
        await expect(response.text()).resolves.toBe("");
      }
    },
  );

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
      const execute = vi.fn(async () => textResult("ok"));
      mockScopedTools([makeMessageTool({ execute })]);
      beginMcpLoopbackToolCallCapture({
        captureKey,
        onRequestStart: () => {
          events.push("start");
          admitted.resolve();
        },
        onRequestClassified: () => events.push("classified"),
        onToolCallResult: () => events.push("result"),
      });
      const { runtime, port } = await startLoopbackServerForTest();
      const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
      const received: Buffer[] = [];
      const socketErrors: string[] = [];
      socket.on("error", (error) => socketErrors.push(error.message));
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("end", () => {
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
        await withTestTimeout(closed, 2_000, "body probe socket close timed out");
        expect(
          await waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
            timeoutMs: 100,
          }),
        ).toBe(true);
        const wire = Buffer.concat(received).toString();
        const statuses = [...wire.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((match) =>
          Number(match[1]),
        );
        expect(socketErrors).toEqual([]);
        expect(events.filter((event) => event === "start").length).toBeGreaterThan(0);
        expect(events.filter((event) => event === "classified")).toHaveLength(
          events.filter((event) => event === "start").length,
        );
        expect(execute).not.toHaveBeenCalled();
        if (mode !== "disconnect") {
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
    const payload = await listTools(scope);
    return (payload.result?.tools ?? []).map((tool) => tool.name);
  }

  async function callStructuredOutput(scope: { token: string; headers?: Record<string, string> }) {
    return await callTool({
      ...scope,
      name: "structured_output",
      args: { result: { answer: "ok" } },
    });
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
    await getResponse.body?.cancel();
    await expectStatus(send("DELETE", captureKey));

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
      await expectStatus(
        sendRaw({
          port: successor.port,
          token: successorGrant.token,
          headers: jsonHeaders({ "x-openclaw-cli-capture-key": "capture-successor" }),
          body: mcpToolsListBody(),
        }),
      );
    } finally {
      clearMcpLoopbackToolCallCapture(captureKey);
      finishStalledRequest();
      await responsePromise.catch(() => undefined);
      await (oldClose ?? closeMcpLoopbackServer()).catch(() => undefined);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

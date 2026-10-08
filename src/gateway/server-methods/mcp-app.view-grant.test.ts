import { randomUUID } from "node:crypto";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createSessionMcpRuntime } from "../../agents/agent-bundle-mcp-runtime.js";
import type { McpToolCatalog, SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import {
  fetchMcpAppView,
  getMcpAppViewLease,
  releaseMcpAppView,
  type McpAppPrepareToolCall,
} from "../../agents/mcp-ui-resource.js";
import * as configIo from "../../config/io.runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { McpServerConfig } from "../../config/types.mcp.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadExecApprovalsReadOnly } from "../../infra/exec-approvals-store.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { prepareMcpAppExtensionRuntime } from "../mcp-app-extension-runtime.js";
import * as approvalStore from "../operator-approval-store.js";
import { createGatewayAuxHandlers } from "../server-aux-handlers.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { makeClient } from "../server-broadcast.test-helpers.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "../server-startup-config.test-support.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { mcpAppHandlers } from "./mcp-app.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  loadConfig: vi.fn(),
  projection: vi.fn(),
  policy: vi.fn(),
  native: vi.fn(),
  registered: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("../../agents/agent-bundle-mcp-runtime-config.js", () => ({
  loadSessionMcpConfig: mocks.loadConfig,
}));
vi.mock("../../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: () => undefined,
}));
vi.mock("../../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: async () => false,
  releaseSessionMcpRuntime: async (lease: { releaseLease: () => void }) => lease.releaseLease(),
}));
vi.mock("../../agents/harness/registry.js", () => ({
  getRegisteredAgentHarness: mocks.registered,
}));
vi.mock("../../agents/thinking-runtime.js", () => ({
  resolveEffectiveAgentRuntime: () => "codex",
}));
vi.mock("../../plugins/current-plugin-metadata-state.js", () => ({
  getGatewayPluginMetadataSnapshot: () => undefined,
}));
vi.mock("../session-utils-model-selection.js", () => ({
  resolveSessionSelectedModelRef: () => ({ provider: "openai", model: "model" }),
}));
vi.mock("../session-row-projection-access.js", () => ({
  getSessionRowProjection: mocks.projection,
}));
vi.mock("../session-resource-tool-policy.js", () => ({
  resolveSessionResourceToolPolicy: mocks.policy,
}));
vi.mock("./session-scoped-read.js", () => ({ retainSessionScopedRead: () => undefined }));
vi.mock("../mcp-app-reconstruction.js", () => ({ restoreMcpAppView: async () => undefined }));

const sessionKey = "agent:main:parts";
const serverName = "parts";
type ApprovalEvent = { id: string; request: PluginApprovalRequestPayload };
type Path = "model-created" | "extension-runtime";
let state: OpenClawTestState;
let aux: ReturnType<typeof createGatewayAuxHandlers>;
let cfg: OpenClawConfig;
let server: McpServerConfig;
let entry: SessionEntry;
let runtime: SessionMcpRuntime;
let context: GatewayRequestHandlerOptions["context"];
let nextApproval = createDeferred<ApprovalEvent>();
let approvals: ApprovalEvent[];
let pendingCalls: Promise<unknown>[];
let views: string[];
let retained: Array<{ release: () => void }>;
let extensions: Array<Awaited<ReturnType<typeof prepareMcpAppExtensionRuntime>>>;
const reviewer = makeClient("approval-reviewer", "operator", [
  "operator.admin",
  "operator.approvals",
]);
const writeConfig = vi.spyOn(configIo, "writeConfigFile");
const persistApproval = approvalStore.resolveOperatorApproval;
const resolveApproval = vi.spyOn(approvalStore, "resolveOperatorApproval");

function createRuntime() {
  const catalog: McpToolCatalog = {
    version: 1,
    generatedAt: 1,
    servers: {
      parts: {
        serverName: "parts",
        launchSummary: "parts",
        toolCount: 2,
        pluginId: "parts-plugin",
      },
    },
    tools: ["search", "details"].map((toolName) => ({
      serverName,
      safeServerName: serverName,
      toolName,
      inputSchema: Type.Object({}),
      fallbackDescription: toolName,
      uiVisibility: ["app"],
      codexAnnotations: { readOnlyHint: true },
    })),
  };
  return {
    sessionId: "session-parts",
    sessionKey,
    workspaceDir: state.workspaceDir,
    configFingerprint: "view-grant-fixture",
    createdAt: 1,
    lastUsedAt: 1,
    mcpAppsEnabled: true,
    assertOwnerCurrent: () => {},
    markUsed: () => {},
    acquireLease: () => () => {},
    dispose: async () => {},
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    readResource: async (_serverName: string, uri: string) => ({
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: "<html>Parts search</html>",
          _meta: { ui: {} },
        },
      ],
    }),
    callTool: vi.fn<SessionMcpRuntime["callTool"]>(
      async (_server, toolName, _input, callOptions) => {
        callOptions?.assertCurrent?.();
        return { content: [{ type: "text", text: toolName }] };
      },
    ),
  } satisfies SessionMcpRuntime;
}

function options(
  params: Record<string, unknown>,
  requesterId = "alice",
  method = "mcp.app.callTool",
) {
  const controller = new AbortController();
  return {
    req: { type: "req", id: "app-call", method, params },
    params,
    respond: vi.fn(),
    client: {
      connId: "app-" + requesterId,
      connect: { role: "operator", scopes: ["operator.admin"], client: { id: "test" } },
      authenticatedUserProfile: { profileId: requesterId },
    },
    isWebchatConnect: () => false,
    context,
    sessionAccessAuthority: {
      target: { agentId: "main", sessionKey, sessionId: runtime.sessionId },
      assertCurrent: () => controller.signal.throwIfAborted(),
      retain: () => {
        const lease = new AbortController();
        return {
          signal: lease.signal,
          assertCurrent: () => lease.signal.throwIfAborted(),
          release: () => lease.abort(),
        };
      },
    },
  } as unknown as GatewayRequestHandlerOptions;
}

async function openView(path: Path, params: { viewId?: string; requesterId?: string } = {}) {
  let prepareToolCall: McpAppPrepareToolCall | undefined;
  if (path === "extension-runtime") {
    const extension = await prepareMcpAppExtensionRuntime(options({}, params.requesterId));
    extensions.push(extension);
    const authority = extension.retainViewAuthority(extension.catalog.tools);
    retained.push(authority);
    prepareToolCall = authority.prepareToolCall;
  }
  const descriptor = await fetchMcpAppView({
    runtime,
    agentId: "main",
    serverName,
    toolName: "search",
    uiResourceUri: "ui://parts/search",
    toolInput: {},
    toolResult: { content: [] },
    allowedAppToolNames: new Set(["search", "details"]),
    prepareToolCall,
    ...params,
  });
  expect(descriptor).toBeDefined();
  const viewId = descriptor!.viewId;
  views.push(viewId);
  return viewId;
}

function call(
  viewId: string,
  toolName = "search",
  params: { requesterId?: string; sessionKey?: string } = {},
) {
  const request = options(
    {
      sessionKey,
      viewId,
      toolName,
      arguments: { query: "bolt" },
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    },
    params.requesterId,
  );
  const pending = Promise.resolve(mcpAppHandlers["mcp.app.callTool"]!(request)).then(
    () => request.respond,
  );
  pendingCalls.push(pending);
  return pending;
}

async function promptFor(pending: Promise<unknown>) {
  const event = await awaitGateBeforeSettlement(
    nextApproval.promise,
    pending,
    "App call settled without an approval prompt",
  );
  nextApproval = createDeferred<ApprovalEvent>();
  return event;
}

async function decide(event: ApprovalEvent, decision: "allow-once" | "allow-always" | "deny") {
  const request = options({ id: event.id, decision }, "alice", "plugin.approval.resolve");
  request.client = reviewer.client;
  await createPluginApprovalHandlers(aux.pluginApprovalManager)["plugin.approval.resolve"]!(
    request,
  );
  expect(request.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
}

async function approvedCall(
  viewId: string,
  decision: "allow-once" | "allow-always",
  toolName = "search",
  requesterId = "alice",
) {
  const pending = call(viewId, toolName, { requesterId });
  const event = await promptFor(pending);
  expect(event.request.allowedDecisions).toContain(decision);
  await decide(event, decision);
  expect(await pending).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ content: [{ type: "text", text: toolName }] }),
  );
  return event;
}

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "mcp-app-view-grants" });
  aux = createGatewayAuxHandlers({
    scheduler: createTestGatewayScheduler(),
    log: {},
    getNativeApprovalRouteCoordinator: () => undefined,
    activateRuntimeSecrets: createTestRuntimeSecretsActivator(),
    sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    }),
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    clients: [],
    channelManager: {
      startChannel: async () => new Map(),
      stopChannel: async () => {},
      isManuallyStopped: () => false,
      resolveRuntimeAccountId: (_channel, accountId) => accountId,
    },
    logChannels: { info: () => {} },
  });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.clearAllMocks();
  server = { command: "parts-mcp", codex: { defaultToolsApprovalMode: "prompt" } };
  cfg = {
    agents: { entries: { main: {} } },
    mcp: { apps: { enabled: true }, servers: { parts: server } },
  };
  setRuntimeConfigSnapshot(cfg);
  entry = { sessionId: "session-parts", updatedAt: 1 };
  runtime = createRuntime();
  views = [];
  retained = [];
  extensions = [];
  approvals = [];
  pendingCalls = [];
  nextApproval = createDeferred<ApprovalEvent>();
  mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  mocks.loadConfig.mockImplementation(() => ({
    loaded: { mcpServers: { parts: server }, diagnostics: [], prepareDataDirsByServer: {} },
    fingerprint: "view-grant-fixture",
    safeServerNamesByServer: new Map([[serverName, serverName]]),
  }));
  const projection = {
    sharingTarget: () => ({ agentId: "main", canonicalKey: sessionKey, entry }),
  };
  mocks.projection.mockReturnValue(projection);
  mocks.policy.mockReset();
  mocks.native.mockImplementation(async () => ({ runtime, releaseLease: () => {} }));
  mocks.registered.mockReturnValue({
    ownerPluginId: "codex",
    harness: {
      loadMcpToolCatalog: async () => runtime.peekCatalog(),
      acquireMcpAppRuntime: mocks.native,
    },
  });
  reviewer.socket.send.mockImplementation((frame: string) => {
    const event = JSON.parse(frame) as { event: string; payload: ApprovalEvent };
    if (event.event === "plugin.approval.requested") {
      approvals.push(event.payload);
      nextApproval.resolve(event.payload);
    }
  });
  context = {
    ...createGatewayBroadcaster({ clients: new GatewayClientRegistry([reviewer.client]) }),
    getRuntimeConfig: () => cfg,
    pluginApprovalManager: aux.pluginApprovalManager,
    hasExecApprovalClients: () => true,
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
});

afterEach(async () => {
  for (const record of await aux.pluginApprovalManager.listPendingRecords()) {
    await aux.pluginApprovalManager.resolve(record.id, "deny");
  }
  await Promise.allSettled(pendingCalls);
  for (const viewId of views) {
    releaseMcpAppView(viewId, runtime);
  }
  for (const authority of retained) {
    authority.release();
  }
  for (const extension of extensions) {
    await extension.dispose();
  }
  vi.useRealTimers();
});

afterAll(async () => {
  await aux.stopOperatorInteractions();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await state.cleanup();
});

describe.each<Path>(["model-created", "extension-runtime"])(
  "MCP App view approval via %s",
  (path) => {
    it("grants only the current view and exact tool without config or allowlist persistence", async () => {
      const viewId = await openView(path);
      const first = await approvedCall(viewId, "allow-always");
      expect(first.request).toMatchObject({
        description: "Allow this MCP App to call parts/search once, or while this App stays open?",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        actions: [
          { kind: "decision", decision: "allow-once", label: "Allow once" },
          { kind: "decision", decision: "allow-always", label: "Allow while this App is open" },
          { kind: "decision", decision: "deny", label: "Deny" },
        ],
      });
      expect(first.request).not.toHaveProperty("mcpTool");
      const second = call(viewId);
      await awaitGateBeforeSettlement(
        second,
        nextApproval.promise,
        "Same view/tool unexpectedly prompted again",
      );
      expect(await second).toHaveBeenCalledWith(true, expect.anything());
      expect(approvals).toHaveLength(1);
      await approvedCall(viewId, "allow-once", "details");
      const otherView = await openView(path);
      await approvedCall(otherView, "allow-once");
      expect(approvals).toHaveLength(3);
      expect(runtime.callTool).toHaveBeenCalledTimes(4);
      expect(writeConfig).not.toHaveBeenCalled();
      expect(resolveApproval).toHaveBeenCalled();
      for (const [resolution] of resolveApproval.mock.calls) {
        expect(resolution).not.toHaveProperty("mcpToolGrant");
      }
      expect(loadExecApprovalsReadOnly().agents).toEqual({});
    });

    it.each(["released", "expired", "replaced"])(
      "loses the grant when its exact lease is %s",
      async (reason) => {
        const viewId = await openView(path);
        await approvedCall(viewId, "allow-always");
        if (reason === "released") {
          releaseMcpAppView(viewId, runtime);
        } else if (reason === "expired") {
          vi.setSystemTime(getMcpAppViewLease(viewId, runtime)!.expiresAtMs + 1);
        }
        if (reason !== "replaced") {
          const failed = await call(viewId);
          expect(failed).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ message: expect.stringContaining("view expired") }),
          );
          expect(runtime.callTool).toHaveBeenCalledOnce();
        }
        await openView(path, { viewId });
        await approvedCall(viewId, "allow-once");
        expect(approvals).toHaveLength(2);
      },
    );

    it("consumes allow-once and prompts again; deny never grants", async () => {
      const viewId = await openView(path);
      const once = await approvedCall(viewId, "allow-once");
      expect(await aux.pluginApprovalManager.consumeAllowOnce(once.id, "second-consumer")).toBe(
        false,
      );
      const pending = call(viewId);
      const denied = await promptFor(pending);
      await decide(denied, "deny");
      expect(await pending).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("denied") }),
      );
      await approvedCall(viewId, "allow-once");
      expect(approvals).toHaveLength(3);
      expect(runtime.callTool).toHaveBeenCalledTimes(2);
    });

    it("does not reuse another requester's grant, including on an unbound shared view", async () => {
      const shared = await openView(path);
      await approvedCall(shared, "allow-always");
      await approvedCall(shared, "allow-once", "search", "bob");
      const bound = await openView(path, { requesterId: "alice" });
      await approvedCall(bound, "allow-always");
      expect(await call(bound, "search", { requesterId: "bob" })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("not authorized") }),
      );
      expect(await call(shared, "search", { sessionKey: "agent:main:other" })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("not authorized") }),
      );
      expect(approvals).toHaveLength(3);
      expect(runtime.callTool).toHaveBeenCalledTimes(3);
    });

    it("rechecks policy after approval and before a granted call executes", async () => {
      const viewId = await openView(path);
      const pending = call(viewId);
      const event = await promptFor(pending);
      resolveApproval.mockImplementationOnce(async (input) => {
        const committed = await persistApproval(input);
        expect(committed).toMatchObject({
          outcome: "resolved",
          record: { status: "allowed", decision: "allow-always" },
        });
        entry.toolOverrides = { mcpToolsDeny: { parts: ["search"] } };
        return committed;
      });
      await decide(event, "allow-always");
      expect(await pending).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("denied") }),
      );
      expect(runtime.callTool).not.toHaveBeenCalled();
      entry.toolOverrides = undefined;
      await approvedCall(viewId, "allow-always");
      mocks.policy.mockImplementation(() => {
        throw new Error("Current tool policy revoked");
      });
      expect(await call(viewId)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "Current tool policy revoked" }),
      );
      expect(runtime.callTool).toHaveBeenCalledOnce();
    });

    it.each(["auto", "approve"] as const)(
      "preserves %s server policy precedence for read-only tools",
      async (mode) => {
        server.codex = { defaultToolsApprovalMode: mode };
        const viewId = await openView(path);
        const pending = call(viewId);
        await awaitGateBeforeSettlement(
          pending,
          nextApproval.promise,
          "Existing server policy unexpectedly prompted",
        );
        expect(await pending).toHaveBeenCalledWith(true, expect.anything());
        expect(approvals).toHaveLength(0);
        expect(runtime.callTool).toHaveBeenCalledOnce();
      },
    );
  },
);

it("revalidates a cached App grant after HTTP transport preparation before writing", async ({
  signal,
}) => {
  const mcp = new Server(
    { name: "parts", version: "1" },
    { capabilities: { tools: {}, resources: {} } },
  );
  let toolCalls = 0;
  let posts = 0;
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"], resourceUri: "ui://parts/search" } },
      },
    ],
  }));
  mcp.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
    contents: [
      { uri: params.uri, mimeType: "text/html;profile=mcp-app", text: "<html>Parts search</html>" },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async () => {
    toolCalls += 1;
    return { content: [{ type: "text", text: "search" }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await mcp.connect(transport);
  const listener = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      http.createServer((request, response) => {
        posts += request.method === "POST" ? 1 : 0;
        void transport.handleRequest(request, response).catch(() => {
          if (!response.headersSent) {
            response.writeHead(500).end();
          }
        });
      }),
  });
  const preparing = createDeferred();
  const resume = createDeferred();
  try {
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      vi.stubEnv(name, "");
    }
    server = {
      url: `http://127.0.0.1:${listener.claim.port}/mcp`,
      transport: "streamable-http",
      codex: { defaultToolsApprovalMode: "prompt" },
    };
    cfg.mcp!.servers!.parts = server;
    runtime = createSessionMcpRuntime({
      sessionId: entry.sessionId,
      sessionKey,
      workspaceDir: state.workspaceDir,
      cfg,
    });
    await runtime.getCatalog();
    const viewId = await openView("model-created", { requesterId: "alice" });
    await approvedCall(viewId, "allow-always");
    const reused = call(viewId);
    await awaitGateBeforeSettlement(reused, nextApproval.promise, "Cached grant prompted again");
    expect(await reused).toHaveBeenCalledWith(true, expect.anything());
    expect(toolCalls).toBe(2);
    expect(approvals).toHaveLength(1);
    const beforeDenied = posts;
    expect(await call(viewId, "search", { requesterId: "bob" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not authorized") }),
    );
    expect(posts).toBe(beforeDenied);

    mocks.lookup.mockImplementationOnce(async () => {
      preparing.resolve();
      await resume.promise;
      return [{ address: "127.0.0.1", family: 4 }];
    });
    const revoked = call(viewId);
    await awaitGateBeforeSettlement(
      preparing.promise,
      revoked,
      "Tool never reached HTTP preparation",
    );
    entry.toolOverrides = { mcpToolsDeny: { parts: ["search"] } };
    resume.resolve();
    const response = await revoked;
    expect(posts).toBe(beforeDenied);
    expect(toolCalls).toBe(2);
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("denied") }),
    );
  } finally {
    resume.resolve();
    await Promise.allSettled(pendingCalls);
    for (const viewId of views) {
      releaseMcpAppView(viewId, runtime);
    }
    await runtime.dispose();
    await runtime.joinCleanup?.();
    await mcp.close();
    listener.listener.closeAllConnections();
    await listener.releaseListener();
    await listener.claim.release();
    vi.unstubAllEnvs();
  }
});

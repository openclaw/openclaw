import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  scopedRead: vi.fn(),
  completeDeferredSessionMcpRuntimeRetirement: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  getMcpAppViewLeaseForSession: vi.fn(),
  peekSessionMcpRuntime: vi.fn(),
  restoreMcpAppView: vi.fn(),
  createMcpAppStandaloneTicket: vi.fn(),
  loadSessionMcpConfig: vi.fn(),
  getSessionRowProjection: vi.fn(),
  resolveSessionResourceToolPolicy: vi.fn(),
  requestMcpAppToolApproval: vi.fn(),
}));
vi.mock("../../agents/agent-bundle-mcp-runtime-config.js", () => ({
  loadSessionMcpConfig: mocks.loadSessionMcpConfig,
}));
vi.mock("../session-row-projection-access.js", () => ({
  getSessionRowProjection: mocks.getSessionRowProjection,
}));
vi.mock("../session-resource-tool-policy.js", () => ({
  resolveSessionResourceToolPolicy: mocks.resolveSessionResourceToolPolicy,
}));
vi.mock("../mcp-app-tool-approval.js", () => ({
  requestMcpAppToolApproval: mocks.requestMcpAppToolApproval,
}));

vi.mock("../mcp-app-host-files.js", () => ({ canOpenMcpAppFiles: () => false }));
vi.mock("../operator-role-policy.js", () => ({ resolveGatewayOperatorRoleActor: () => undefined }));
vi.mock("./session-scoped-read.js", () => ({ retainSessionScopedRead: mocks.scopedRead }));
vi.mock("../../agents/mcp-ui-resource.js", () => ({
  getMcpAppViewLease: mocks.getMcpAppViewLease,
  getMcpAppViewLeaseForSession: mocks.getMcpAppViewLeaseForSession,
  acquireMcpAppViewRequest: () => () => {},
}));
vi.mock("../../agents/mcp-app-sandbox.js", () => ({
  buildMcpAppSandboxPath: () => "mcp-app-sandbox",
}));
vi.mock("../../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: mocks.peekSessionMcpRuntime,
}));
vi.mock("../../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: mocks.completeDeferredSessionMcpRuntimeRetirement,
}));
vi.mock("../mcp-app-reconstruction.js", () => ({
  restoreMcpAppView: mocks.restoreMcpAppView,
}));
vi.mock("../mcp-app-standalone.js", () => ({
  createMcpAppStandaloneTicket: mocks.createMcpAppStandaloneTicket,
}));

import type { McpToolCatalog, SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import {
  getMcpAppModelContext,
  leaseMcpAppModelContextForTurn,
} from "../../agents/mcp-app-model-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { McpServerConfig } from "../../config/types.mcp.js";

const policyEntry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
let policyServer: McpServerConfig | undefined;
import type { McpAppPrepareToolCall } from "../../agents/mcp-ui-resource.js";
import { resolveMcpAppAllowedToolNames } from "../mcp-app-operations.js";
import { mcpAppHandlers } from "./mcp-app.js";

const view = {
  requesterId: undefined as string | undefined,
  prepareToolCall: undefined as McpAppPrepareToolCall | undefined,
  viewId: "cv_app",
  agentId: "main",
  sessionId: "session-1",
  serverName: "demo",
  toolName: "show",
  uiResourceUri: "ui://demo/app",
  html: "<html>demo</html>",
  allowedAppToolNames: new Set(["shared", "app-only"]) as ReadonlySet<string> | undefined,
  authorizeAppInteraction: undefined as (() => boolean | Promise<boolean>) | undefined,
  readOnly: undefined as boolean | undefined,
  toolInput: { city: "Paris" },
  toolResult: { content: [{ type: "text", text: "ok" }] },
  expiresAtMs: Date.now() + 60_000,
  requestWindowStartedAtMs: Date.now(),
  requestCount: 0,
  toolCallCount: 0,
  activeRequests: 0,
};

function runtime() {
  const releaseLease = vi.fn();
  const catalog: McpToolCatalog = {
    version: 1,
    generatedAt: 1,
    servers: { demo: { serverName: "demo", launchSummary: "demo", toolCount: 3 } },
    tools: [
      { serverName: "demo", toolName: "shared" },
      { serverName: "demo", toolName: "app-only", uiVisibility: ["app"] as Array<"app" | "model"> },
      {
        serverName: "demo",
        toolName: "model-only",
        uiVisibility: ["model"] as Array<"app" | "model">,
      },
    ].map((tool) =>
      Object.assign(tool, {
        safeServerName: "demo",
        fallbackDescription: tool.toolName,
        inputSchema: Type.Object({}),
      }),
    ),
  };
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    configFingerprint: "gateway-bridge-fixture",
    createdAt: 1,
    lastUsedAt: 1,
    dispose: vi.fn(async () => {}),
    mcpAppsEnabled: true,
    markUsed: vi.fn(),
    acquireLease: vi.fn(() => releaseLease),
    workspaceDir: "/workspace",
    getCatalog: vi.fn(async () => catalog),
    peekCatalog: vi.fn(() => catalog),
    callTool: vi.fn<SessionMcpRuntime["callTool"]>(async (_serverName, toolName) => ({
      content: [{ type: "text", text: toolName }],
    })),
    listTools: vi.fn<NonNullable<SessionMcpRuntime["listTools"]>>(async () => ({
      tools: [
        { name: "shared", inputSchema: { type: "object" } },
        {
          name: "app-only",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["app"] } },
        },
        {
          name: "model-only",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    })),
    listResources: vi.fn(async () => [{ uri: "ui://demo/state", name: "state" }]),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    readResource: vi.fn(async (_serverName: string, uri: string) => ({
      contents: [{ uri, text: "resource" }],
    })),
  };
}

async function invoke(
  method: keyof typeof mcpAppHandlers,
  params: Record<string, unknown>,
  mcpAppsEnabled = true,
  config: Record<string, unknown> = {},
  scopes: string[] = ["operator.write"],
  profileId?: string,
) {
  const respond = vi.fn();
  const cfg = {
    ...config,
    mcp: { apps: { enabled: mcpAppsEnabled, sandboxOrigin: "https://apps.example.com" } },
  };
  await expectDefined(
    mcpAppHandlers[method],
    "mcpAppHandlers[method] test invariant",
  )({
    respond,
    params,
    client: {
      connect: { scopes },
      ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
    },
    context: {
      getMcpAppSandboxPort: () => 18790,
      getRuntimeConfig: () => cfg,
    },
  } as never);
  return respond;
}

describe("MCP App gateway bridge", () => {
  it.each([
    { method: "mcp.app.callTool", field: "arguments", toolName: "shared" },
    { method: "mcp.app.readResource", field: "_meta", uri: "ui://demo/state" },
  ])(
    "rejects malformed $field objects before $method dispatch",
    async ({ method, field, ...input }) => {
      const response = await invoke(method, {
        sessionKey: "agent:main:main",
        viewId: "cv_app",
        ...input,
        [field]: [],
      });
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[2]?.message).toContain(`${field} must be an object`);
    },
  );
  it("keeps unbound shared views available to the authenticated session caller", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    const shown = await invoke("mcp.app.view", params, true, {}, ["operator.write"], "alice");
    expect(shown.mock.calls[0]?.[0]).toBe(true);
    const called = await invoke(
      "mcp.app.callTool",
      { ...params, toolName: "shared", arguments: {} },
      true,
      {},
      ["operator.write"],
      "alice",
    );
    expect(called.mock.calls[0]?.[0]).toBe(true);
  });

  it("isolates requester-bound views, including read and write operations", async () => {
    view.requesterId = "alice";
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    for (const method of [
      "mcp.app.view",
      "mcp.app.modelContext",
      "mcp.app.updateModelContext",
      "mcp.app.readResource",
    ]) {
      const denied = await invoke(
        method,
        { ...params, uri: "ui://demo/state" },
        true,
        {},
        ["operator.write"],
        "bob",
      );
      expect(denied.mock.calls[0]?.[0]).toBe(false);
    }
    const allowed = await invoke("mcp.app.view", params, true, {}, ["operator.write"], "alice");
    expect(allowed.mock.calls[0]?.[0]).toBe(true);
  });

  it("round-trips rich context metadata and guards removal with updateId through registered handlers", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    const content = [
      { type: "text", text: "one", _meta: { "openai/title": "One" } },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ];
    const written = await invoke("mcp.app.updateModelContext", {
      ...params,
      content,
      structuredContent: { selected: 1 },
    });
    expect(written.mock.calls[0]?.[0]).toBe(true);
    const updateId = written.mock.calls[0]?.[1]._meta["openai/modelContext"].updateId;
    const read = await invoke("mcp.app.modelContext", params);
    expect(read.mock.calls[0]?.[1].state).toEqual({
      updateId,
      content,
      structuredContent: { selected: 1 },
    });
    const removed = await invoke("mcp.app.removeModelContext", { ...params, updateId, index: 0 });
    expect(removed.mock.calls[0]?.[1].state.content).toEqual([content[1]]);
    const stale = await invoke("mcp.app.removeModelContext", { ...params, updateId, index: 0 });
    expect(stale.mock.calls[0]?.[0]).toBe(false);
  });
  it("publishes a clearing receipt when a turn consumes context and accepts late removal", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    const activeRuntime = runtime();
    mocks.peekSessionMcpRuntime.mockReturnValue(activeRuntime);
    const broadcastToConnIds = vi.fn();
    const connection = new AbortController();
    const respond = vi.fn();
    try {
      await mcpAppHandlers["mcp.app.view"]!({
        params,
        respond,
        client: {
          connId: "context-client",
          connectionSignal: connection.signal,
          connect: { scopes: ["operator.write"] },
        },
        context: {
          getMcpAppSandboxPort: () => 18790,
          getRuntimeConfig: () => ({ mcp: { apps: { enabled: true } } }),
          broadcastToConnIds,
        },
      } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      const written = await invoke("mcp.app.updateModelContext", {
        ...params,
        content: [{ type: "text", text: "selected hex bolt" }],
      });
      const updateId = written.mock.calls[0]?.[1]._meta["openai/modelContext"].updateId;
      broadcastToConnIds.mockClear();
      const turn = leaseMcpAppModelContextForTurn({ runtime: activeRuntime });
      expect(turn).toBeDefined();
      turn!.commit();
      expect
        .soft(broadcastToConnIds)
        .toHaveBeenCalledWith(
          "mcp.app.hostContextChanged",
          { viewId: "cv_app", modelContext: null, updateId },
          new Set(["context-client"]),
        );
      const removed = await invoke("mcp.app.removeModelContext", { ...params, updateId, index: 0 });
      expect(removed.mock.calls[0]?.slice(0, 2)).toEqual([true, { state: null }]);
    } finally {
      connection.abort();
    }
  });
  beforeEach(() => {
    policyEntry.sessionId = "session-1";
    policyEntry.permissionMode = undefined;
    policyEntry.toolOverrides = undefined;
    policyServer = { command: "demo", codex: { defaultToolsApprovalMode: "approve" } };
    mocks.loadSessionMcpConfig.mockReset().mockImplementation(() => ({
      loaded: { mcpServers: policyServer ? { demo: policyServer } : {} },
    }));
    mocks.getSessionRowProjection.mockReset().mockReturnValue({
      sharingTarget: () => ({
        agentId: "main",
        canonicalKey: "agent:main:main",
        entry: policyEntry,
      }),
    });
    mocks.resolveSessionResourceToolPolicy.mockReset();
    mocks.requestMcpAppToolApproval
      .mockReset()
      .mockImplementation(async (request) => request.assertCurrent());
    view.requesterId = undefined;
    view.prepareToolCall = undefined;
    mocks.scopedRead.mockReset().mockReturnValue(undefined);
    view.requestCount = 0;
    view.toolCallCount = 0;
    view.activeRequests = 0;
    view.allowedAppToolNames = new Set(["shared", "app-only"]);
    view.authorizeAppInteraction = undefined;
    view.readOnly = undefined;
    mocks.getMcpAppViewLease.mockReset().mockReturnValue(view);
    mocks.getMcpAppViewLeaseForSession.mockReset().mockReturnValue(undefined);
    mocks.completeDeferredSessionMcpRuntimeRetirement.mockReset().mockResolvedValue(false);
    mocks.peekSessionMcpRuntime.mockReset().mockReturnValue(runtime());
    mocks.restoreMcpAppView.mockReset().mockResolvedValue(undefined);
    mocks.createMcpAppStandaloneTicket.mockReset().mockReturnValue({
      ticket: "ticket",
      url: "/__openclaw__/mcp-app#ticket",
      expiresAtMs: 1_800_000_120_000,
    });
  });

  it("uses canonical interactive approval for a model-created view and each current caller", async () => {
    policyServer = { command: "demo", codex: { defaultToolsApprovalMode: "prompt" } };
    view.requesterId = "alice";
    const active = runtime();
    mocks.peekSessionMcpRuntime.mockReturnValue(active);
    const args = {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      toolName: "shared",
      arguments: { selected: 1 },
    };
    const first = await invoke("mcp.app.callTool", args, true, {}, ["operator.write"], "alice");
    const second = await invoke("mcp.app.callTool", args, true, {}, ["operator.write"], "alice");
    expect(first.mock.calls[0]?.[0]).toBe(true);
    expect(second.mock.calls[0]?.[0]).toBe(true);
    expect(mocks.requestMcpAppToolApproval).toHaveBeenCalledTimes(2);
    const approval = mocks.requestMcpAppToolApproval.mock.calls[0]![0];
    expect(approval).toMatchObject({
      serverName: "demo",
      toolName: "shared",
      sessionKey: args.sessionKey,
      agentId: "main",
      input: args.arguments,
      options: { client: { authenticatedUserProfile: { profileId: "alice" } } },
    });
    expect(mocks.requestMcpAppToolApproval.mock.calls[1]![0].options).not.toBe(approval.options);
    expect(mocks.resolveSessionResourceToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "demo__shared", client: approval.options.client }),
    );
    expect(active.callTool).toHaveBeenCalledTimes(2);
  });

  it.each(["deny", "revoked session", "revoked tool", "revoked current policy", "changed catalog"])(
    "does not execute model-view tools after %s during approval",
    async (reason) => {
      policyServer = { command: "demo", codex: { defaultToolsApprovalMode: "prompt" } };
      const active = runtime();
      mocks.peekSessionMcpRuntime.mockReturnValue(active);
      const gate = createDeferred();
      const entered = createDeferred();
      mocks.requestMcpAppToolApproval.mockImplementation(async (request) => {
        entered.resolve();
        await gate.promise;
        if (reason === "deny") {
          throw new Error("denied");
        }
        request.assertCurrent();
      });
      const pending = invoke("mcp.app.callTool", {
        sessionKey: "agent:main:main",
        viewId: "cv_app",
        toolName: "shared",
      });
      await entered.promise;
      if (reason === "revoked session") {
        policyEntry.sessionId = "replacement";
      } else if (reason === "revoked tool") {
        policyEntry.toolOverrides = { mcpToolsDeny: { demo: ["shared"] } };
      } else if (reason === "revoked current policy") {
        mocks.resolveSessionResourceToolPolicy.mockImplementation(() => {
          throw new Error("revoked");
        });
      } else if (reason === "changed catalog") {
        active.peekCatalog().tools[0]!.codexAnnotations = { destructiveHint: true };
      }
      gate.resolve();
      expect((await pending).mock.calls[0]?.[0]).toBe(false);
      expect(active.callTool).not.toHaveBeenCalled();
    },
  );

  it("denies unknown origins instead of treating missing config as an approval grant", async () => {
    policyServer = undefined;
    const active = runtime();
    mocks.peekSessionMcpRuntime.mockReturnValue(active);
    expect(
      (
        await invoke("mcp.app.callTool", {
          sessionKey: "agent:main:main",
          viewId: "cv_app",
          toolName: "shared",
        })
      ).mock.calls[0]?.[0],
    ).toBe(false);
    expect(active.callTool).not.toHaveBeenCalled();
    expect(mocks.requestMcpAppToolApproval).not.toHaveBeenCalled();
  });

  it("requires approval for inventory proven by a live native plugin owner", async () => {
    policyServer = undefined;
    policyEntry.permissionMode = "full";
    const active = { ...runtime(), assertOwnerCurrent: vi.fn() };
    active.peekCatalog().servers.demo!.pluginId = "native-plugin";
    mocks.peekSessionMcpRuntime.mockReturnValue(active);
    expect(
      (
        await invoke("mcp.app.callTool", {
          sessionKey: "agent:main:main",
          viewId: "cv_app",
          toolName: "shared",
        })
      ).mock.calls[0]?.[0],
    ).toBe(true);
    expect(mocks.requestMcpAppToolApproval).toHaveBeenCalledOnce();
    expect(active.assertOwnerCurrent).toHaveBeenCalled();
    expect(active.callTool).toHaveBeenCalledOnce();
  });

  it("checks current server filters before requesting approval", async () => {
    policyServer = {
      command: "demo",
      toolFilter: { exclude: ["shared"] },
      codex: { defaultToolsApprovalMode: "prompt" },
    };
    const active = runtime();
    mocks.peekSessionMcpRuntime.mockReturnValue(active);
    expect(
      (
        await invoke("mcp.app.callTool", {
          sessionKey: "agent:main:main",
          viewId: "cv_app",
          toolName: "shared",
        })
      ).mock.calls[0]?.[0],
    ).toBe(false);
    expect(mocks.requestMcpAppToolApproval).not.toHaveBeenCalled();
    expect(active.callTool).not.toHaveBeenCalled();
  });

  it("passes each current request to the view’s tool preparation hook", async () => {
    const prepare = vi.fn<McpAppPrepareToolCall>(async (request) => request.assertCurrent());
    view.prepareToolCall = prepare;
    await invoke("mcp.app.callTool", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      toolName: "shared",
      arguments: { n: 1 },
    });
    await invoke("mcp.app.callTool", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      toolName: "shared",
      arguments: { n: 2 },
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]![0].options).not.toBe(prepare.mock.calls[1]![0].options);
    expect(prepare.mock.calls[1]![0]).toMatchObject({
      toolName: "shared",
      input: { n: 2 },
      options: { params: { arguments: { n: 2 } } },
    });
  });

  it("retains a preparation guard and checks it before upstream tool effects", async () => {
    const active = runtime();
    mocks.peekSessionMcpRuntime.mockReturnValue(active);
    const guard = vi.fn(() => {
      throw new Error("approval policy changed");
    });
    view.prepareToolCall = async () => guard;
    const reply = await invoke("mcp.app.callTool", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      toolName: "shared",
    });
    expect(reply.mock.calls[0]?.[0]).toBe(false);
    expect(guard).toHaveBeenCalled();
    expect(active.callTool).not.toHaveBeenCalled();
  });

  it("revalidates the view after awaited preparation before upstream tool effects", async () => {
    const entered = createDeferred();
    const approved = createDeferred();
    view.prepareToolCall = async (request) => {
      entered.resolve();
      await approved.promise;
      request.assertCurrent();
    };
    const pending = invoke("mcp.app.callTool", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      toolName: "shared",
    });
    await entered.promise;
    view.allowedAppToolNames = undefined;
    approved.resolve();
    expect((await pending).mock.calls[0]?.[0]).toBe(false);
    expect(mocks.peekSessionMcpRuntime.mock.results[0]?.value.callTool).not.toHaveBeenCalled();
  });

  it("returns typed selection-required for a bare key without an owner", async () => {
    const config = {
      agents: {
        ownership: "explicit",
        list: [{ id: "ops" }, { id: "research" }],
      },
    };
    const missing = await invoke(
      "mcp.app.view",
      { sessionKey: "global", viewId: "cv_app" },
      true,
      config,
    );
    expect(missing).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("agent"),
      }),
    );

    await invoke(
      "mcp.app.view",
      { sessionKey: "global", agentId: "research", viewId: "cv_app" },
      true,
      config,
    );
    expect(mocks.restoreMcpAppView).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "global", agentId: "research" }),
    );
  });

  it("returns the ephemeral view payload only for the bound session", async () => {
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sandboxUrl: "mcp-app-sandbox",
        sandboxPort: 18790,
        sandboxOrigin: "https://apps.example.com",
        html: "<html>demo</html>",
        toolInput: { city: "Paris" },
        standaloneUrl: "/__openclaw__/mcp-app#ticket",
        standaloneExpiresAtMs: 1_800_000_120_000,
        messageSupported: true,
        updateModelContextSupported: true,
      }),
    );
    expect(mocks.getMcpAppViewLease).toHaveBeenCalledWith("cv_app", expect.any(Object));
    expect(mocks.createMcpAppStandaloneTicket).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      toolOperationsAuthorized: true,
      view,
    });
    const activeRuntime = mocks.peekSessionMcpRuntime.mock.results[0]?.value;
    expect(activeRuntime.acquireLease).toHaveBeenCalledOnce();
    expect(activeRuntime.acquireLease.mock.results[0]?.value).toHaveBeenCalledOnce();
    expect(mocks.completeDeferredSessionMcpRuntimeRetirement).toHaveBeenCalledWith(activeRuntime);
  });

  it("mints a view-only standalone ticket for a read-scoped caller", async () => {
    await invoke("mcp.app.view", { sessionKey: "agent:main:main", viewId: "cv_app" }, true, {}, [
      "operator.read",
    ]);

    expect(mocks.createMcpAppStandaloneTicket).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      toolOperationsAuthorized: false,
      view,
    });
  });

  it("resolves a harness-native view through its originating session", async () => {
    const nativeRuntime = runtime();
    const nativeView = { ...view, runtime: nativeRuntime };
    mocks.peekSessionMcpRuntime.mockReturnValue(undefined);
    mocks.getMcpAppViewLeaseForSession.mockReturnValue(nativeView);

    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ html: "<html>demo</html>" });
    expect(mocks.getMcpAppViewLeaseForSession).toHaveBeenCalledWith(
      "cv_app",
      "agent:main:main",
      "main",
    );
    expect(mocks.restoreMcpAppView).not.toHaveBeenCalled();
  });

  it("does not reuse a live bare-key view owned by another agent", async () => {
    const nativeRuntime = runtime();
    const nativeView = { ...view, agentId: "ops", runtime: nativeRuntime };
    mocks.peekSessionMcpRuntime.mockReturnValue(undefined);
    mocks.getMcpAppViewLeaseForSession.mockImplementation(
      (_viewId: string, _sessionKey: string, agentId: string) =>
        agentId === "ops" ? nativeView : undefined,
    );

    const respond = await invoke(
      "mcp.app.view",
      { sessionKey: "global", agentId: "research", viewId: "cv_app" },
      true,
      {
        agents: {
          ownership: "explicit",
          list: [{ id: "ops" }, { id: "research" }],
        },
      },
    );

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.getMcpAppViewLeaseForSession).toHaveBeenCalledWith("cv_app", "global", "research");
  });

  it("preserves the existing view payload when standalone ticket issuance is unavailable", async () => {
    mocks.createMcpAppStandaloneTicket.mockImplementation(() => {
      throw new Error("ticket unavailable");
    });
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ html: "<html>demo</html>" });
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("standaloneUrl");
  });

  it("does not replace a completed bridge response with a cleanup error", async () => {
    mocks.completeDeferredSessionMcpRuntimeRetirement.mockRejectedValueOnce(
      new Error("dispose failed"),
    );
    const respond = await invoke("mcp.app.callTool", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      toolName: "shared",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      content: [{ type: "text", text: "shared" }],
    });
  });

  it("keeps message support disabled without fresh run authority", async () => {
    view.allowedAppToolNames = undefined;
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      messageSupported: false,
      updateModelContextSupported: false,
    });
  });

  it("supports messages for a fresh view with no app-callable tools", async () => {
    view.allowedAppToolNames = new Set();
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      messageSupported: true,
      updateModelContextSupported: true,
    });
  });

  it("stores only the latest bounded text update and clears it with an empty update", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    const first = await invoke("mcp.app.updateModelContext", {
      ...params,
      content: [{ type: "text", text: "first" }],
    });
    const activeRuntime = mocks.peekSessionMcpRuntime.mock.results[0]?.value;
    expect(first.mock.calls[0]?.[0]).toBe(true);
    expect(getMcpAppModelContext(activeRuntime, view)?.content).toEqual([
      { type: "text", text: "first" },
    ]);

    const second = await invoke("mcp.app.updateModelContext", {
      ...params,
      content: [{ type: "text", text: "second" }],
    });
    expect(second.mock.calls[0]?.[0]).toBe(true);
    expect(getMcpAppModelContext(activeRuntime, view)?.content).toEqual([
      { type: "text", text: "second" },
    ]);

    const cleared = await invoke("mcp.app.updateModelContext", params);
    expect(cleared.mock.calls[0]?.[0]).toBe(true);
    expect(getMcpAppModelContext(activeRuntime, view)).toBeNull();
  });

  it("rejects unsupported context shapes, oversized UTF-8 text, and read-only views", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    for (const update of [
      { structuredContent: [] },
      { content: [{ type: "audio", data: "AA==", mimeType: "audio/wav" }] },
      { content: [{ type: "text", text: "é".repeat(3 * 1024 * 1024 + 1) }] },
    ]) {
      const respond = await invoke("mcp.app.updateModelContext", { ...params, ...update });
      expect(respond.mock.calls[0]?.[0]).toBe(false);
    }

    view.readOnly = true;
    const readOnly = await invoke("mcp.app.updateModelContext", {
      ...params,
      content: [{ type: "text", text: "blocked" }],
    });
    expect(readOnly.mock.calls[0]?.[0]).toBe(false);
  });

  it("does not reconstruct expired views for context writes", async () => {
    mocks.getMcpAppViewLease.mockReturnValue(undefined);
    const respond = await invoke("mcp.app.updateModelContext", {
      sessionKey: "agent:main:main",
      viewId: "expired",
      content: [{ type: "text", text: "blocked" }],
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.restoreMcpAppView).not.toHaveBeenCalled();
  });

  it("rejects context writes without fresh run authority", async () => {
    view.allowedAppToolNames = undefined;
    const respond = await invoke("mcp.app.updateModelContext", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      content: [{ type: "text", text: "blocked" }],
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    const activeRuntime = mocks.peekSessionMcpRuntime.mock.results[0]?.value;
    expect(getMcpAppModelContext(activeRuntime, view)).toBeNull();
  });

  it("rechecks current widget authority for every interactive capability", async () => {
    const activeRuntime = runtime();
    mocks.peekSessionMcpRuntime.mockReturnValue(activeRuntime);
    view.authorizeAppInteraction = vi.fn(async () => false);
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };

    const payload = await invoke("mcp.app.view", params);
    expect(payload.mock.calls[0]?.[1]).toMatchObject({
      messageSupported: false,
      updateModelContextSupported: false,
    });
    const update = await invoke("mcp.app.updateModelContext", {
      ...params,
      content: [{ type: "text", text: "stale" }],
    });
    expect(update.mock.calls[0]?.[0]).toBe(false);
    const listed = await invoke("mcp.app.listTools", params);
    expect(listed.mock.calls[0]?.[0]).toBe(false);
    const called = await invoke("mcp.app.callTool", { ...params, toolName: "shared" });
    expect(called.mock.calls[0]?.[0]).toBe(false);
    const resources = await invoke("mcp.app.listResources", params);
    expect(resources.mock.calls[0]?.[0]).toBe(false);
    const templates = await invoke("mcp.app.listResourceTemplates", params);
    expect(templates.mock.calls[0]?.[0]).toBe(false);
    const resource = await invoke("mcp.app.readResource", {
      ...params,
      uri: "ui://demo/state",
    });
    expect(resource.mock.calls[0]?.[0]).toBe(false);
    expect(view.authorizeAppInteraction).toHaveBeenCalledTimes(7);
    expect(getMcpAppModelContext(activeRuntime, view)).toBeNull();
    expect(activeRuntime.callTool).not.toHaveBeenCalled();
    expect(activeRuntime.listResources).not.toHaveBeenCalled();
    expect(activeRuntime.listResourceTemplates).not.toHaveBeenCalled();
    expect(activeRuntime.readResource).not.toHaveBeenCalled();
  });

  it.each([
    {
      capability: "resource list",
      method: "mcp.app.listResources" as const,
      params: {},
      runtimeMethod: "listResources" as const,
      result: [{ uri: "ui://demo/state", name: "state" }],
    },
    {
      capability: "resource template list",
      method: "mcp.app.listResourceTemplates" as const,
      params: {},
      runtimeMethod: "listResourceTemplates" as const,
      result: { resourceTemplates: [{ uriTemplate: "ui://demo/{id}", name: "demo" }] },
    },
    {
      capability: "resource read",
      method: "mcp.app.readResource" as const,
      params: { uri: "ui://demo/state" },
      runtimeMethod: "readResource" as const,
      result: { contents: [{ uri: "ui://demo/state", text: "protected" }] },
    },
  ])(
    "withholds $capability results when widget authority is revoked in flight",
    async (testCase) => {
      const resourceStarted = createDeferred();
      const releaseResource = createDeferred<unknown>();
      const activeRuntime = runtime();
      activeRuntime[testCase.runtimeMethod].mockImplementationOnce(async () => {
        resourceStarted.resolve();
        return (await releaseResource.promise) as never;
      });
      mocks.peekSessionMcpRuntime.mockReturnValue(activeRuntime);
      let grantActive = true;
      view.authorizeAppInteraction = vi.fn(async () => grantActive);

      const pending = invoke(testCase.method, {
        sessionKey: "agent:main:main",
        viewId: "cv_app",
        ...testCase.params,
      });
      await resourceStarted.promise;
      expect(view.authorizeAppInteraction).toHaveBeenCalledOnce();
      grantActive = false;
      releaseResource.resolve(testCase.result);

      const denied = await pending;
      expect(denied.mock.calls[0]?.[0]).toBe(false);
      expect(denied.mock.calls[0]?.[2]).toMatchObject({
        message: "MCP App widget grant is no longer active",
      });
      expect(view.authorizeAppInteraction).toHaveBeenCalledTimes(2);
    },
  );

  it("filters model-only tools from app discovery and execution", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    const listed = await invoke("mcp.app.listTools", params);
    expect(listed.mock.calls[0]?.[1].tools.map((tool: { name: string }) => tool.name)).toEqual([
      "shared",
      "app-only",
    ]);

    const denied = await invoke("mcp.app.callTool", { ...params, toolName: "model-only" });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
  });

  it("keeps the originating run allowlist authoritative for App calls", async () => {
    view.allowedAppToolNames = new Set(["shared"]);
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };

    const listed = await invoke("mcp.app.listTools", params);
    expect(listed.mock.calls[0]?.[1].tools.map((tool: { name: string }) => tool.name)).toEqual([
      "shared",
    ]);

    const denied = await invoke("mcp.app.callTool", { ...params, toolName: "app-only" });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
  });

  it.each([
    {
      capability: "calling an App tool",
      method: "mcp.app.callTool" as const,
      params: { toolName: "shared" },
      assertNoToolCall: true,
    },
    {
      capability: "returning App tools",
      method: "mcp.app.listTools" as const,
      params: {},
      assertNoToolCall: false,
    },
  ])("rechecks the widget grant after discovery before $capability", async (testCase) => {
    const catalogStarted = createDeferred();
    const releaseCatalog =
      createDeferred<Awaited<ReturnType<ReturnType<typeof runtime>["getCatalog"]>>>();
    const activeRuntime = runtime();
    mocks.peekSessionMcpRuntime.mockReturnValue(activeRuntime);
    activeRuntime.getCatalog.mockImplementationOnce(async () => {
      catalogStarted.resolve();
      return await releaseCatalog.promise;
    });
    let grantActive = true;
    view.authorizeAppInteraction = vi.fn(async () => grantActive);

    const pending = invoke(testCase.method, {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      ...testCase.params,
    });
    await catalogStarted.promise;
    expect(view.authorizeAppInteraction).toHaveBeenCalledOnce();
    grantActive = false;
    releaseCatalog.resolve({
      ...activeRuntime.peekCatalog(),
      tools: activeRuntime.peekCatalog().tools.filter((tool) => tool.toolName === "shared"),
    });

    const denied = await pending;
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(view.authorizeAppInteraction).toHaveBeenCalledTimes(2);
    if (testCase.assertNoToolCall) {
      expect(activeRuntime.callTool).not.toHaveBeenCalled();
    }
  });

  it("captures only app-visible tools allowed by the originating view", async () => {
    const activeRuntime = runtime();
    const activeView = {
      ...view,
      allowedAppToolNames: new Set(["app-only", "model-only"]),
    };

    await expect(
      resolveMcpAppAllowedToolNames({ runtime: activeRuntime as never, view: activeView as never }),
    ).resolves.toEqual(["app-only"]);
    await expect(
      resolveMcpAppAllowedToolNames({
        runtime: activeRuntime as never,
        view: { ...activeView, readOnly: true } as never,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects views that are not backed by the transcript", async () => {
    mocks.getMcpAppViewLease.mockReturnValue(undefined);
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "expired",
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      details: { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED },
    });
    expect(mocks.restoreMcpAppView).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        viewId: "expired",
      }),
    );
  });

  it("rejects disabled Apps before attempting transcript reconstruction", async () => {
    mocks.peekSessionMcpRuntime.mockReturnValue(undefined);

    const respond = await invoke(
      "mcp.app.view",
      { sessionKey: "agent:main:main", viewId: "cv_app" },
      false,
    );

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.restoreMcpAppView).not.toHaveBeenCalled();
  });

  it("restores a transcript-backed view after a Gateway restart", async () => {
    const restoredRuntime = runtime();
    const restoredView = {
      ...view,
      runtime: restoredRuntime,
      allowedAppToolNames: new Set(),
      readOnly: true,
    };
    mocks.peekSessionMcpRuntime.mockReturnValue(undefined);
    mocks.restoreMcpAppView.mockResolvedValue({
      runtime: restoredRuntime,
      view: restoredView,
    });

    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      html: "<html>demo</html>",
      messageSupported: false,
      updateModelContextSupported: false,
    });
  });
});

import { expectDefined } from "@openclaw/normalization-core";
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

import type { SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
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
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { makeClient } from "../server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { mcpAppHandlers } from "./mcp-app.js";
import { runtime } from "./mcp-app.test-support.js";

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
    { label: "empty", params: { cursor: "" } },
    { label: "padded", params: { cursor: " page-2 " } },
  ])(
    "preserves $label list cursors through registered handlers and App operations",
    async ({ params }) => {
      const cursor = params.cursor;
      const isSecondPage = (request: { cursor?: string } | undefined) => request?.cursor === cursor;
      const activeRuntime = {
        ...runtime(),
        listResourceTemplates: vi.fn<NonNullable<SessionMcpRuntime["listResourceTemplates"]>>(
          async (_server, request) => {
            const second = isSecondPage(request);
            const name = second ? "second" : "first";
            return {
              resourceTemplates: [{ name, uriTemplate: `fixture://${name}/{id}` }],
              ...(second ? {} : { nextCursor: cursor }),
            };
          },
        ),
      };
      activeRuntime.listTools.mockImplementation(async (_server, request) => {
        const second = isSecondPage(request);
        return {
          tools: [{ name: second ? "app-only" : "shared", inputSchema: { type: "object" } }],
          ...(second ? {} : { nextCursor: cursor }),
        };
      });
      mocks.peekSessionMcpRuntime.mockReturnValue(activeRuntime);
      const binding = { sessionKey: "agent:main:main", viewId: "cv_app" };
      for (const [method, runtimeMethod, items, secondName] of [
        ["mcp.app.listTools", "listTools", "tools", "app-only"],
        ["mcp.app.listResourceTemplates", "listResourceTemplates", "resourceTemplates", "second"],
      ] as const) {
        const first = await invoke(method, binding);
        expect(first.mock.calls[0]?.[0]).toBe(true);
        expect(first.mock.calls[0]?.[1].nextCursor).toBe(cursor);
        const response = await invoke(method, { ...binding, ...params });
        expect(response.mock.calls[0]?.[0]).toBe(true);
        expect(activeRuntime[runtimeMethod]).toHaveBeenLastCalledWith("demo", { cursor });
        expect(response.mock.calls[0]?.[1][items]).toEqual([
          expect.objectContaining({ name: secondName }),
        ]);
      }
      const resources = await invoke("mcp.app.listResources", { ...binding, ...params });
      expect(resources.mock.calls[0]?.[1]).toEqual({
        resources: [{ uri: "ui://demo/state", name: "state" }],
      });
      expect(activeRuntime.listResources).toHaveBeenLastCalledWith("demo");
    },
  );

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
  it("delivers the latest clearing receipt after two context updates and accepts late removal", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    const activeRuntime = runtime();
    mocks.peekSessionMcpRuntime.mockReturnValue(activeRuntime);
    const owner = makeClient("context-client", "operator", ["operator.read"]);
    const observer = makeClient("observer", "operator", ["operator.read"]);
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([owner.client, observer.client]),
    });
    const connection = new AbortController();
    const respond = vi.fn();
    try {
      await mcpAppHandlers["mcp.app.view"]!({
        params,
        respond,
        client: {
          ...owner.client,
          connectionSignal: connection.signal,
        },
        context: {
          getMcpAppSandboxPort: () => 18790,
          getRuntimeConfig: () => ({ mcp: { apps: { enabled: true } } }),
          broadcastToConnIds,
        },
      } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      await invoke("mcp.app.updateModelContext", {
        ...params,
        content: [
          { type: "text", text: "selected hex bolt" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
      });
      const written = await invoke("mcp.app.updateModelContext", {
        ...params,
        content: [
          { type: "text", text: "selected hex bolt" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          { type: "resource_link", uri: "parts://bolt", name: "Bolt" },
        ],
      });
      const updateId = written.mock.calls[0]?.[1]._meta["openai/modelContext"].updateId;
      owner.socket.send.mockClear();
      const turn = leaseMcpAppModelContextForTurn({ runtime: activeRuntime });
      expect(turn).toBeDefined();
      turn!.commit();
      expect(owner.socket.send.mock.calls.map(([frame]) => JSON.parse(frame))).toEqual([
        expect.objectContaining({
          event: "mcp.app.hostContextChanged",
          payload: { viewId: "cv_app", modelContext: null, updateId },
        }),
      ]);
      expect(observer.socket.send).not.toHaveBeenCalled();
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

  it.each(["revoked session", "revoked tool", "revoked current policy", "changed catalog"])(
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
        entries: { ops: {}, research: {} },
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
          entries: { ops: {}, research: {} },
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

  it("withholds resource read results when widget authority is revoked in flight", async () => {
    const resourceStarted = createDeferred();
    const activeRuntime = runtime();
    const releaseResource =
      createDeferred<Awaited<ReturnType<typeof activeRuntime.readResource>>>();
    activeRuntime.readResource.mockImplementationOnce(async () => {
      resourceStarted.resolve();
      return await releaseResource.promise;
    });
    mocks.peekSessionMcpRuntime.mockReturnValue(activeRuntime);
    let grantActive = true;
    view.authorizeAppInteraction = vi.fn(async () => grantActive);

    const pending = invoke("mcp.app.readResource", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      uri: "ui://demo/state",
    });
    await resourceStarted.promise;
    expect(view.authorizeAppInteraction).toHaveBeenCalledOnce();
    grantActive = false;
    releaseResource.resolve({ contents: [{ uri: "ui://demo/state", text: "protected" }] });

    const denied = await pending;
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(denied.mock.calls[0]?.[2]).toMatchObject({
      message: "MCP App widget grant is no longer active",
    });
    expect(view.authorizeAppInteraction).toHaveBeenCalledTimes(2);
  });

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

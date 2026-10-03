import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolCatalog } from "../../agents/agent-bundle-mcp-types.js";
import { readMcpAppToolExtensions } from "../../agents/mcp-app-extension-metadata.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { mcpAppExtensionHandlers } from "./mcp-app-extensions.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  fetch: vi.fn(),
  call: vi.fn(),
  assert: vi.fn(),
  dispose: vi.fn(),
  release: vi.fn(),
  file: vi.fn(),
  upload: vi.fn(),
  viewCleanup: new Set<() => void>(),
}));
vi.mock("../mcp-app-extension-runtime.js", () => ({
  prepareMcpAppExtensionRuntime: mocks.prepare,
}));
vi.mock("../mcp-app-host-files.js", () => ({ prepareMcpAppHostFile: mocks.file }));
vi.mock("../../agents/mcp-form-resource-upload.js", () => ({
  prepareMcpAppFormUpload: mocks.upload,
}));
vi.mock("../mcp-app-operations.js", () => ({
  callMcpAppToolWithElicitation: async (request: {
    origin: { runtime: { callTool: typeof mocks.call }; serverName: string };
    toolName: string;
    input: unknown;
    assertCurrent: () => void;
  }) =>
    request.origin.runtime.callTool(request.origin.serverName, request.toolName, request.input, {
      assertCurrent: request.assertCurrent,
    }),
}));
vi.mock("../../plugins/current-plugin-metadata-state.js", () => ({
  getGatewayPluginMetadataSnapshot: () => undefined,
}));
vi.mock("../../agents/mcp-ui-resource.js", () => ({
  fetchMcpAppView: mocks.fetch,
  getMcpAppViewLease: () => ({ disposeCallbacks: mocks.viewCleanup }),
  buildMcpAppCanvasPayload: (value: unknown) => value,
}));
let catalog: McpToolCatalog;
const settings = {
  schema: { type: "object", properties: { enabled: { type: "boolean", title: "Enabled" } } },
  values: { enabled: true },
  layout: [
    { kind: "group", title: "Account", items: [{ kind: "tool", tool: "show", title: "Account" }] },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewCleanup.clear();
  mocks.upload.mockResolvedValue(undefined);
  mocks.dispose.mockResolvedValue(undefined);
  catalog = {
    version: 1,
    generatedAt: 1,
    servers: {
      demo: {
        serverName: "demo",
        launchSummary: "fixture",
        toolCount: 4,
        settings: { readTool: "read", updateTool: "update" },
      },
    },
    tools: ["show", "read", "update", "mentions"].map((toolName) =>
      Object.assign(
        {
          serverName: "demo",
          safeServerName: "demo",
          toolName,
          inputSchema: { type: "object" } as never,
          fallbackDescription: toolName,
        },
        toolName === "show"
          ? {
              uiResourceUri: "ui://demo/app",
              uiVisibility: ["model" as const],
              appExtensions: readMcpAppToolExtensions({
                _meta: {
                  "openai/ui": {
                    entrypoints: [{ type: "global" }, { type: "file", extensions: [".stl"] }],
                  },
                },
              }),
            }
          : toolName === "mentions"
            ? { appExtensions: { mentionSearch: true as const } }
            : {},
      ),
    ),
  };
  mocks.call.mockResolvedValue({ content: [], structuredContent: settings });
  mocks.fetch.mockResolvedValue({
    viewId: "mcp-app-demo",
    title: "Demo",
    serverName: "demo",
    toolName: "show",
    uiResourceUri: "ui://demo/app",
  });
  mocks.file.mockResolvedValue({ name: "part.stl", resourceUri: "openclaw-file://1" });
  mocks.prepare.mockImplementation(async (options) => ({
    options,
    runtime: { callTool: mocks.call },
    catalog,
    agentId: "main",
    sessionKey: "agent:main:test",
    requesterId: "alice",
    assertCurrent: mocks.assert,
    assertTool: mocks.assert,
    approveTool: async () => mocks.assert,
    dispose: mocks.dispose,
    retainViewAuthority: () => ({ assertCurrent: mocks.assert, release: mocks.release }),
  }));
});
async function invoke(method: string, params: Record<string, unknown>, enabled = true) {
  const respond = vi.fn();
  await mcpAppExtensionHandlers[method]!({
    params: { sessionKey: "agent:main:test", ...params },
    context: { getRuntimeConfig: () => ({ mcp: { apps: { enabled } } }) },
    respond,
  } as unknown as GatewayRequestHandlerOptions);
  return respond;
}
describe("registered MCP App extensions", () => {
  it("returns empty discovery without opening transports when Apps are disabled", async () => {
    const response = await invoke("mcp.app.discover", {}, false);
    expect(response).toHaveBeenCalledWith(true, { servers: [], onboarding: [] });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("registers every handler with explicit operator and session authority", () => {
    const descriptors = createCoreGatewayMethodDescriptors(mcpAppExtensionHandlers);
    const registry = createGatewayMethodRegistry(descriptors);
    expect(registry.getScope("mcp.app.discover")).toBe("operator.write");
    expect(registry.getHandler("mcp.app.discover")).toBe(
      mcpAppExtensionHandlers["mcp.app.discover"],
    );
    expect(descriptors).toHaveLength(4);
    expect(
      descriptors.every(
        (entry) => entry.sessionAccess?.mode === "write" && entry.profileAccess === "required",
      ),
    ).toBe(true);
  });
  it("discovers manually launched Apps regardless of model visibility", async () => {
    const respond = await invoke("mcp.app.discover", {});
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        servers: [
          expect.objectContaining({
            entrypoints: expect.arrayContaining([
              expect.objectContaining({ toolName: "show", entrypoint: { type: "global" } }),
            ]),
            settings: { readTool: "read", updateTool: "update" },
            mentionTool: "mentions",
          }),
        ],
      }),
    );
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("calls the entrypoint exactly once and seeds the view with that result", async () => {
    const respond = await invoke("mcp.app.launch", {
      serverName: "demo",
      toolName: "show",
      entrypointType: "global",
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ viewId: "mcp-app-demo" }));
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      "demo",
      "show",
      {},
      { assertCurrent: expect.any(Function) },
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInput: {},
        toolResult: { content: [], structuredContent: settings },
        requesterId: "alice",
      }),
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it.each(["upload", "view", "missing view"])(
    "releases launch authority when %s preparation fails",
    async (failure) => {
      if (failure === "upload") {
        mocks.upload
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("upload failed"));
      } else if (failure === "view") {
        mocks.fetch.mockRejectedValueOnce(new Error("view failed"));
      } else {
        mocks.fetch.mockResolvedValueOnce(undefined);
      }
      const response = await invoke("mcp.app.launch", {
        serverName: "demo",
        toolName: "show",
        entrypointType: "global",
      });
      expect(response).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(mocks.release).toHaveBeenCalledTimes(2);
      expect(mocks.viewCleanup.size).toBe(0);
      expect(mocks.dispose).toHaveBeenCalledOnce();
    },
  );
  it("transfers successful launch authority to the installed view exactly once", async () => {
    const response = await invoke("mcp.app.launch", {
      serverName: "demo",
      toolName: "show",
      entrypointType: "global",
    });
    expect(response).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ viewId: "mcp-app-demo" }),
    );
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    const authorize = mocks.fetch.mock.calls[0]![0].authorizeAppInteraction;
    expect(authorize()).toBe(true);
    mocks.assert.mockImplementationOnce(() => {
      throw new Error("session revoked");
    });
    expect(authorize).toThrow("session revoked");
    expect(mocks.viewCleanup.size).toBe(1);
    for (const cleanup of mocks.viewCleanup) {
      cleanup();
    }
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
  it("passes only a host-minted resource to file entrypoints", async () => {
    await invoke("mcp.app.launch", {
      serverName: "demo",
      toolName: "show",
      entrypointType: "file",
      filePath: "part.stl",
    });
    expect(mocks.call).toHaveBeenCalledWith(
      "demo",
      "show",
      {
        file: { name: "part.stl", resourceUri: "openclaw-file://1" },
      },
      { assertCurrent: expect.any(Function) },
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ hostFile: { name: "part.stl", resourceUri: "openclaw-file://1" } }),
    );
  });
  it("does not dispatch an unadvertised launch or forged file resource", async () => {
    const missing = await invoke("mcp.app.launch", {
      serverName: "demo",
      toolName: "update",
      entrypointType: "global",
    });
    expect(missing).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    await invoke("mcp.app.launch", {
      serverName: "demo",
      toolName: "show",
      entrypointType: "file",
      file: { name: "a.stl", resourceUri: "file:///private" },
    });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("routes changed settings and only current layout actions", async () => {
    await invoke("mcp.app.settings", {
      serverName: "demo",
      action: "update",
      arguments: { set: { enabled: false } },
    });
    expect(mocks.call).toHaveBeenCalledWith(
      "demo",
      "update",
      { set: { enabled: false } },
      { assertCurrent: expect.any(Function) },
    );
    mocks.call.mockClear();
    const response = await invoke("mcp.app.settings", {
      serverName: "demo",
      action: "tool",
      toolName: "update",
    });
    expect(response).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      "demo",
      "read",
      {},
      { assertCurrent: expect.any(Function) },
    );
  });
  it("returns resource links from structured mention results", async () => {
    const resource = { type: "resource_link", uri: "cad://part", name: "Part" };
    mocks.call.mockResolvedValue({ content: [], structuredContent: { items: [resource] } });
    const response = await invoke("mcp.app.mention", { serverName: "demo", query: "part" });
    expect(response).toHaveBeenCalledWith(true, { resources: [resource] });
    expect(mocks.call).toHaveBeenCalledWith(
      "demo",
      "mentions",
      { query: "part" },
      { assertCurrent: expect.any(Function) },
    );
  });
  it("does not return protected data after revocation during the call", async () => {
    mocks.call.mockImplementation(async () => {
      mocks.assert.mockImplementation(() => {
        throw new Error("revoked");
      });
      return { content: [], structuredContent: settings };
    });
    const response = await invoke("mcp.app.settings", { serverName: "demo", action: "read" });
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "revoked" }),
    );
    mocks.assert.mockReset();
  });
});

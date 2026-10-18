import { expect, test, vi } from "vitest";
import type { McpToolCatalog } from "../agents/agent-bundle-mcp-types.js";
import { getRuntimeConfig } from "../config/io.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createCoreGatewayMethodDescriptors } from "./methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { mcpAppExtensionHandlers } from "./server-methods/mcp-app-extensions.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { setupSessionCreateHandlerTestHarness } from "./server.sessions.create.test-support.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";

const mcp = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  acquireSessionMcpRuntime: mcp.acquire,
}));
vi.mock("../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  releaseSessionMcpRuntime: mcp.release,
}));
vi.mock("../agents/thinking-runtime.js", () => ({
  resolveEffectiveAgentRuntime: () => "openclaw",
}));
vi.mock("./session-resource-tool-policy.js", () => ({
  resolveSessionResourceToolPolicy: () => ({}),
}));

const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness();

test("global App discovery uses a session admitted by sessions.create before any model turn", async () => {
  await createSessionStoreDir();
  const cfg = {
    ...getRuntimeConfig(),
    mcp: { apps: { enabled: true }, servers: { demo: { command: "fixture" } } },
  };
  const owner = ensureProfileForEmail("app-discovery@example.test");
  const client = identifiedClient(owner.id);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  await initializeSessionReadContext(context);
  const catalog: McpToolCatalog = {
    version: 1,
    generatedAt: 1,
    servers: { demo: { serverName: "demo", launchSummary: "fixture", toolCount: 1 } },
    tools: [
      {
        serverName: "demo",
        safeServerName: "demo",
        toolName: "show",
        inputSchema: { type: "object" },
        fallbackDescription: "Show app",
        uiResourceUri: "ui://demo/app",
        appExtensions: { entrypoints: [{ type: "global" }] },
      },
    ],
  };
  mcp.acquire.mockResolvedValue({ runtime: { getCatalog: async () => catalog } });
  const sessionKey = "agent:main:main";
  const discover = async () => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "discovery",
        method: "mcp.app.discover",
        params: { sessionKey, agentId: "main" },
      },
      respond,
      client,
      context,
      isWebchatConnect: () => true,
      methodRegistry: createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors(mcpAppExtensionHandlers),
      ),
    });
    return respond;
  };
  expect(await discover()).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(mcp.acquire).not.toHaveBeenCalled();
  const created = await directSessionReq(
    "sessions.create",
    { key: sessionKey, agentId: "main" },
    {
      client,
      context: { getRuntimeConfig: () => cfg },
    },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(await discover()).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      servers: [
        expect.objectContaining({ entrypoints: [expect.objectContaining({ toolName: "show" })] }),
      ],
    }),
  );
  expect(mcp.acquire).toHaveBeenCalledOnce();
});

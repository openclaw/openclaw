import { expect, test, vi } from "vitest";
import { fixtureCatalog } from "../agents/agent-bundle-mcp-fixture.test-support.js";
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
  const client = identifiedClient(ensureProfileForEmail("app-discovery@example.test").id);
  const runtimeContext = { getRuntimeConfig: () => cfg };
  const context = createDirectChatContext(runtimeContext);
  await initializeSessionReadContext(context);
  const catalog = fixtureCatalog("demo", [
    {
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      appExtensions: { entrypoints: [{ type: "global" }] },
    },
  ]);
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
    return respond.mock.calls;
  };
  expect(await discover()).toMatchObject([[false, undefined, { code: "FORBIDDEN" }]]);
  expect(mcp.acquire).not.toHaveBeenCalled();
  const created = await directSessionReq(
    "sessions.create",
    { key: sessionKey, agentId: "main" },
    { client, context: runtimeContext },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(await discover()).toMatchObject([
    [true, { servers: [{ entrypoints: [{ toolName: "show" }] }] }],
  ]);
  expect(mcp.acquire).toHaveBeenCalledOnce();
});

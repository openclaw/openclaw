import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawToolsOptions } from "../../src/agents/openclaw-tools.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "../../src/gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../src/gateway/server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "../../src/gateway/server-request-context.js";
import { makeContextParams } from "../../src/gateway/server-request-context.test-support.js";
import { createToolsInvokeHttpTestServer } from "../../src/gateway/tools-invoke-http.test-support.js";

const login = vi.hoisted(() => ({ start: vi.fn(), wait: vi.fn() }));
const cfg = vi.hoisted((): OpenClawConfig => ({ tools: { allow: ["whatsapp_login"] } }));

// mock-isolation: Keep external WhatsApp sessions and credential persistence outside this fixture.
vi.mock("../../extensions/whatsapp/login-qr-api.js", () => ({
  startWebLoginWithQr: login.start,
  waitForWebLogin: login.wait,
}));
vi.mock("../../src/config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/config.js")>()),
  getRuntimeConfig: () => cfg,
}));
vi.mock("../../src/config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/io.js")>()),
  getRuntimeConfig: () => cfg,
}));
vi.mock("../../src/config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/sessions/session-accessor.js")>()),
  loadExactSessionEntryCandidates: () => [],
}));
// mock-isolation: Assemble only the registered WhatsApp tools, without unrelated core tool runtimes.
vi.mock("../../src/agents/openclaw-tools.js", async () => {
  const { registerWhatsAppAgentTools } =
    await import("../../extensions/whatsapp/agent-tools-api.js");
  const { createTestPluginRegistry } =
    await import("../../src/plugins/registry-runtime.test-helpers.js");
  const { createPluginRecord } = await import("../../src/plugins/status.test-helpers.js");
  const { createPluginToolFactoryContext } =
    await import("../../src/plugins/tool-factory-context.js");
  const { bindPluginToolCallbacks } = await import("../../src/plugins/tool-factory-runtime.js");
  const { setPluginToolMeta } = await import("../../src/plugins/tool-metadata.js");
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "whatsapp",
    contracts: { tools: ["whatsapp_login", "whatsapp_call"] },
  });
  builder.registry.plugins.push(record);
  registerWhatsAppAgentTools(builder.createApi(record, { config: cfg, registrationMode: "full" }));
  return {
    createOpenClawToolsAsync: async (options: OpenClawToolsOptions) => {
      const entry = builder.registry.tools.find((candidate) =>
        candidate.names.includes("whatsapp_login"),
      );
      if (!entry) throw new Error("WhatsApp login factory was not registered");
      const context = createPluginToolFactoryContext({
        entry,
        registry: builder.registry,
        context: { senderIsOwner: options.senderIsOwner },
        assertInvocationCurrent: options.assertInvocationCurrent,
      });
      const raw = entry.factory(context);
      if (!raw) return [];
      if (Array.isArray(raw)) throw new Error("Expected one WhatsApp login tool");
      setPluginToolMeta(raw, { pluginId: "whatsapp", optional: false });
      return [
        bindPluginToolCallbacks(entry, builder.registry, raw, context.assertInvocationCurrent),
      ];
    },
  };
});

const { handleToolsInvokeHttpRequest } = await import("../../src/gateway/tools-invoke-http.js");
const { toolsInvokeHandlers } = await import("../../src/gateway/server-methods/tools-invoke.js");
const server = createToolsInvokeHttpTestServer({ handleToolsInvoke: handleToolsInvokeHttpRequest });
let port = 0;
beforeAll(async () => {
  port = await server.listen();
});
afterAll(() => server.close());
beforeEach(() => {
  login.start.mockReset().mockResolvedValue({ message: "login started" });
  login.wait.mockReset().mockResolvedValue({ message: "login pending", connected: false });
  server.resetContext();
});

async function invokeHttp(args: Record<string, unknown>, action?: string) {
  const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "whatsapp_login", args, ...(action ? { action } : {}) }),
  });
  return { status: response.status, body: await response.json() };
}

async function invokeRpc(args: Record<string, unknown>, owner = true) {
  const respond = vi.fn();
  const handler = toolsInvokeHandlers["tools.invoke"];
  if (!handler) throw new Error("tools.invoke handler is unavailable");
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = () => cfg;
  const options: GatewayRequestHandlerOptions = {
    params: { name: "whatsapp_login", args },
    respond,
    context,
    client: createSyntheticPluginRuntimeClient({
      scopes: [owner ? "operator.admin" : "operator.write"],
    }),
    req: { type: "req", id: "whatsapp-proof", method: "tools.invoke" },
    isWebchatConnect: () => false,
    signal: new AbortController().signal,
  };
  await handler(options);
  return respond.mock.calls[0];
}

describe("registered WhatsApp login through Gateway invocation", () => {
  it.each([null, 42, "bogus"])(
    "rejects nested action %j despite a valid HTTP fallback",
    async (action) => {
      expect(await invokeHttp({ action }, "wait")).toMatchObject({
        status: 400,
        body: {
          ok: false,
          error: {
            type: "tool_error",
            message: 'Unknown WhatsApp login action. Expected "start" or "wait".',
          },
        },
      });
      expect(login.start).not.toHaveBeenCalled();
      expect(login.wait).not.toHaveBeenCalled();
    },
  );

  it.each([
    { args: { action: "wait" }, fallback: "start", expected: "wait" },
    { args: { action: "start" }, fallback: "wait", expected: "start" },
    { args: {}, fallback: "wait", expected: "wait" },
    { args: {}, fallback: undefined, expected: "start" },
  ])(
    "dispatches $expected with nested $args and fallback $fallback",
    async ({ args, fallback, expected }) => {
      const result = await invokeHttp(
        { ...args, accountId: " account-1 ", timeoutMs: "5000" },
        fallback,
      );
      expect(result).toMatchObject({ status: 200, body: { ok: true } });
      const selected = expected === "wait" ? login.wait : login.start;
      const other = expected === "wait" ? login.start : login.wait;
      expect(selected).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ accountId: " account-1 ", timeoutMs: 5000 }),
      );
      expect(other).not.toHaveBeenCalled();
    },
  );

  it("serializes the registered input error using the existing RPC vocabulary", async () => {
    expect(await invokeRpc({ action: null })).toEqual([
      true,
      {
        ok: false,
        toolName: "whatsapp_login",
        error: {
          code: "internal_error",
          message: 'Unknown WhatsApp login action. Expected "start" or "wait".',
        },
      },
      undefined,
    ]);
    expect(login.start).not.toHaveBeenCalled();
    expect(login.wait).not.toHaveBeenCalled();
  });

  it("retains valid RPC dispatch and owner-only availability", async () => {
    expect(await invokeRpc({ action: "wait" })).toMatchObject([true, { ok: true }, undefined]);
    expect(login.wait).toHaveBeenCalledOnce();
    login.wait.mockClear();
    expect(await invokeRpc({ action: "wait" }, false)).toMatchObject([
      true,
      { ok: false, error: { code: "not_found" } },
      undefined,
    ]);
    expect(login.start).not.toHaveBeenCalled();
    expect(login.wait).not.toHaveBeenCalled();
  });
});

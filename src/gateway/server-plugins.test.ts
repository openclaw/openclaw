import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
const primeConfiguredBindingRegistry = vi.hoisted(() =>
  vi.fn(() => ({ bindingCount: 0, channelCount: 0 })),
);
type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("../channels/plugins/binding-registry.js", () => ({
  primeConfiguredBindingRegistry,
}));

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

vi.mock("../channels/registry.js", () => ({
  CHAT_CHANNEL_ORDER: [],
  CHANNEL_IDS: [],
  listChatChannels: () => [],
  listChatChannelAliases: () => [],
  getChatChannelMeta: () => null,
  normalizeChatChannelId: () => null,
  normalizeChannelId: () => null,
  normalizeAnyChannelId: () => null,
  formatChannelPrimerLine: () => "",
  formatChannelSelectionLine: () => "",
}));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  channelSetups: [],
  commands: [],
  providers: [],
  speechProviders: [],
  mediaUnderstandingProviders: [],
  imageGenerationProviders: [],
  webSearchProviders: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  conversationBindingResolvedHandlers: [],
  diagnostics,
});

type ServerPluginsModule = typeof import("./server-plugins.js");
type PluginRuntimeModule = typeof import("../plugins/runtime/index.js");
type GatewayRequestScopeModule = typeof import("../plugins/runtime/gateway-request-scope.js");
type MethodScopesModule = typeof import("./method-scopes.js");

let serverPluginsModule: ServerPluginsModule;
let runtimeModule: PluginRuntimeModule;
let gatewayRequestScopeModule: GatewayRequestScopeModule;
let methodScopesModule: MethodScopesModule;

function createTestContext(label: string): GatewayRequestContext {
  return { label } as unknown as GatewayRequestContext;
}

function getLastDispatchedContext(): GatewayRequestContext | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.context;
}

function getLastDispatchedParams(): Record<string, unknown> | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.req?.params as Record<string, unknown> | undefined;
}

function getLastDispatchedClientScopes(): string[] {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  const scopes = call?.client?.connect?.scopes;
  return Array.isArray(scopes) ? scopes : [];
}

async function loadTestModules() {
  serverPluginsModule = await import("./server-plugins.js");
  runtimeModule = await import("../plugins/runtime/index.js");
  gatewayRequestScopeModule = await import("../plugins/runtime/gateway-request-scope.js");
  methodScopesModule = await import("./method-scopes.js");
}

async function createSubagentRuntime(
  serverPlugins: ServerPluginsModule,
  cfg: Record<string, unknown> = {},
): Promise<PluginRuntime["subagent"]> {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  serverPlugins.loadGatewayPlugins({
    cfg,
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
  });
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
    | undefined;
  if (call?.runtimeOptions?.allowGatewaySubagentBinding !== true) {
    throw new Error("Expected loadGatewayPlugins to opt into gateway subagent binding");
  }
  return runtimeModule.createPluginRuntime({ allowGatewaySubagentBinding: true }).subagent;
}

async function reloadServerPluginsModule(): Promise<ServerPluginsModule> {
  vi.resetModules();
  await loadTestModules();
  return serverPluginsModule;
}

beforeAll(async () => {
  await loadTestModules();
});

beforeEach(() => {
  loadOpenClawPlugins.mockReset();
  primeConfiguredBindingRegistry.mockClear().mockReturnValue({ bindingCount: 0, channelCount: 0 });
  handleGatewayRequest.mockReset();
  runtimeModule.clearGatewaySubagentRuntime();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    switch (opts.req.method) {
      case "agent":
        opts.respond(true, { runId: "run-1" });
        return;
      case "agent.wait":
        opts.respond(true, { status: "ok" });
        return;
      case "sessions.get":
        opts.respond(true, { messages: [] });
        return;
      case "sessions.delete":
        opts.respond(true, {});
        return;
      default:
        opts.respond(true, {});
    }
  });
});

afterEach(() => {
  runtimeModule.clearGatewaySubagentRuntime();
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", async () => {
    const { loadGatewayPlugins } = serverPluginsModule;
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("provides subagent runtime with sessions.get method aliases", async () => {
    const { loadGatewayPlugins } = serverPluginsModule;
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
      | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
      | undefined;
    expect(call?.runtimeOptions?.allowGatewaySubagentBinding).toBe(true);
    const subagent = runtimeModule.createPluginRuntime({
      allowGatewaySubagentBinding: true,
    }).subagent;
    expect(typeof subagent?.getSessionMessages).toBe("function");
    expect(typeof subagent?.getSession).toBe("function");
  });

  test("forwards provider and model overrides when the request scope is authorized", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const scope = {
      context: createTestContext("request-scope-forward-overrides"),
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
      runtime.run({
        sessionKey: "s-override",
        message: "use the override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-override",
      message: "use the override",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      deliver: false,
    });
  });

  test("rejects provider/model overrides for fallback runs without explicit authorization", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-deny-overrides"));

    await expect(
      runtime.run({
        sessionKey: "s-fallback-override",
        message: "use the override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    ).rejects.toThrow(
      "provider/model override requires plugin identity in fallback subagent runs.",
    );
  });

  test("allows trusted fallback provider/model overrides when plugin config is explicit", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-trusted-overrides"));
    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
      runtime.run({
        sessionKey: "s-trusted-override",
        message: "use trusted override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-trusted-override",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  test("includes docs guidance when a plugin fallback override is not trusted", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-untrusted-plugin"));

    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          sessionKey: "s-untrusted-override",
          message: "use untrusted override",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          deliver: false,
        }),
      ),
    ).rejects.toThrow(
      'plugin "voice-call" is not trusted for fallback provider/model override requests. See https://docs.openclaw.ai/tools/plugin#runtime-helpers and search for: plugins.entries.<id>.subagent.allowModelOverride',
    );
  });

  test("allows trusted fallback model-only overrides when the model ref is canonical", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-model-only-override"));
    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
      runtime.run({
        sessionKey: "s-model-only-override",
        message: "use trusted model-only override",
        model: "anthropic/claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-model-only-override",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(getLastDispatchedParams()).not.toHaveProperty("provider");
  });

  test("rejects trusted fallback overrides when the configured allowlist normalizes to empty", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-invalid-allowlist"));
    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          sessionKey: "s-invalid-allowlist",
          message: "use trusted override",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          deliver: false,
        }),
      ),
    ).rejects.toThrow(
      'plugin "voice-call" configured subagent.allowedModels, but none of the entries normalized to a valid provider/model target.',
    );
  });

  test("uses least-privilege synthetic fallback scopes without admin", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-least-privilege"));

    await runtime.run({
      sessionKey: "s-synthetic",
      message: "run synthetic",
      deliver: false,
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("allows fallback session reads with synthetic write scope", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-session-read"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      const scopes = Array.isArray(opts.client?.connect?.scopes) ? opts.client.connect.scopes : [];
      const auth = methodScopesModule.authorizeOperatorScopesForMethod("sessions.get", scopes);
      if (!auth.allowed) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `missing scope: ${auth.missingScope}`,
        });
        return;
      }
      opts.respond(true, { messages: [{ id: "m-1" }] });
    });

    await expect(
      runtime.getSessionMessages({
        sessionKey: "s-read",
      }),
    ).resolves.toEqual({
      messages: [{ id: "m-1" }],
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("keeps admin scope for fallback session deletion", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-delete-session"));

    await runtime.deleteSession({
      sessionKey: "s-delete",
      deleteTranscript: true,
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.admin"]);
  });

  test("can prefer setup-runtime channel plugins during startup loads", async () => {
    const { loadGatewayPlugins } = serverPluginsModule;
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
      preferSetupRuntimeForChannelPlugins: true,
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        preferSetupRuntimeForChannelPlugins: true,
      }),
    );
  });

  test("primes configured bindings during gateway startup", async () => {
    const { loadGatewayPlugins } = serverPluginsModule;
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const cfg = {};
    loadGatewayPlugins({
      cfg,
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(primeConfiguredBindingRegistry).toHaveBeenCalledWith({ cfg });
  });

  test("can suppress duplicate diagnostics when reloading full runtime plugins", async () => {
    const { loadGatewayPlugins } = serverPluginsModule;
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
      logDiagnostics: false,
    });

    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
  test("shares fallback context across module reloads for existing runtimes", async () => {
    const first = serverPluginsModule;
    const runtime = await createSubagentRuntime(first);

    const staleContext = createTestContext("stale");
    first.setFallbackGatewayContext(staleContext);
    await runtime.run({ sessionKey: "s-1", message: "hello" });
    expect(getLastDispatchedContext()).toBe(staleContext);

    const reloaded = await reloadServerPluginsModule();
    const freshContext = createTestContext("fresh");
    reloaded.setFallbackGatewayContext(freshContext);

    await runtime.run({ sessionKey: "s-1", message: "hello again" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });

  test("uses updated fallback context after context replacement", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const firstContext = createTestContext("before-restart");
    const secondContext = createTestContext("after-restart");

    serverPlugins.setFallbackGatewayContext(firstContext);
    await runtime.run({ sessionKey: "s-2", message: "before restart" });
    expect(getLastDispatchedContext()).toBe(firstContext);

    serverPlugins.setFallbackGatewayContext(secondContext);
    await runtime.run({ sessionKey: "s-2", message: "after restart" });
    expect(getLastDispatchedContext()).toBe(secondContext);
  });

  test("reflects fallback context object mutation at dispatch time", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const context = { marker: "before-mutation" } as GatewayRequestContext & {
      marker: string;
    };

    serverPlugins.setFallbackGatewayContext(context);
    context.marker = "after-mutation";

    await runtime.run({ sessionKey: "s-3", message: "mutated context" });
    const dispatched = getLastDispatchedContext() as
      | (GatewayRequestContext & { marker: string })
      | undefined;
    expect(dispatched?.marker).toBe("after-mutation");
  });
});

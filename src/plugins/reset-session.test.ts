import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginRecord } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  OpenClawPluginApi,
  PluginRegistrationMode,
  PluginResetSessionResult,
} from "./types.js";

const resolveModuleId = (specifier: string) => fileURLToPath(new URL(specifier, import.meta.url));

const AUTH_PROFILES_OAUTH_MODULE_IDS = [
  "../agents/auth-profiles/oauth.js",
  "../agents/auth-profiles/oauth.ts",
  resolveModuleId("../agents/auth-profiles/oauth.js"),
  resolveModuleId("../agents/auth-profiles/oauth.ts"),
];
const MODEL_AUTH_MODULE_IDS = [
  "../agents/model-auth.js",
  "../agents/model-auth.ts",
  resolveModuleId("../agents/model-auth.js"),
  resolveModuleId("../agents/model-auth.ts"),
];

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProviders: () => [],
  getOAuthApiKey: vi.fn(async () => ""),
  loginOpenAICodex: vi.fn(),
}));

const mockPluginSideEffects = () => {
  vi.doMock("../agents/sandbox/constants.js", () => {
    return {
      DEFAULT_SANDBOX_WORKSPACE_ROOT: "/tmp/sandboxes",
      DEFAULT_SANDBOX_IMAGE: "sandbox:test",
      DEFAULT_SANDBOX_CONTAINER_PREFIX: "sandbox-",
      DEFAULT_SANDBOX_WORKDIR: "/workspace",
      DEFAULT_SANDBOX_IDLE_HOURS: 1,
      DEFAULT_SANDBOX_MAX_AGE_DAYS: 1,
      DEFAULT_TOOL_ALLOW: [] as const,
      DEFAULT_TOOL_DENY: [] as const,
      DEFAULT_SANDBOX_BROWSER_IMAGE: "sandbox-browser:test",
      DEFAULT_SANDBOX_COMMON_IMAGE: "sandbox-common:test",
      SANDBOX_BROWSER_SECURITY_HASH_EPOCH: "test",
      DEFAULT_SANDBOX_BROWSER_PREFIX: "sandbox-browser-",
      DEFAULT_SANDBOX_BROWSER_NETWORK: "sandbox-net",
      DEFAULT_SANDBOX_BROWSER_CDP_PORT: 0,
      DEFAULT_SANDBOX_BROWSER_VNC_PORT: 0,
      DEFAULT_SANDBOX_BROWSER_NOVNC_PORT: 0,
      DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS: 0,
      SANDBOX_AGENT_WORKSPACE_MOUNT: "/agent",
      SANDBOX_STATE_DIR: "/tmp/sandbox",
      SANDBOX_REGISTRY_PATH: "/tmp/sandbox/containers.json",
      SANDBOX_BROWSER_REGISTRY_PATH: "/tmp/sandbox/browsers.json",
    };
  });

  const mockAuthProfilesOauth = {
    resolveApiKeyForProfile: vi.fn(async () => ({
      apiKey: "",
      provider: "mock",
    })),
    getOAuthProviders: vi.fn(() => []),
  };
  for (const id of AUTH_PROFILES_OAUTH_MODULE_IDS) {
    vi.doMock(id, () => mockAuthProfilesOauth);
  }
  for (const id of MODEL_AUTH_MODULE_IDS) {
    vi.doMock(id, () => ({
      getApiKeyForModel: vi.fn(async () => null),
      resolveApiKeyForProvider: vi.fn(async () => null),
      ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
      resolveAuthProfileOrder: vi.fn(() => []),
    }));
  }

  vi.doMock("openclaw/plugin-sdk/text-runtime", async () => {
    return await import("../plugin-sdk/text-runtime.js");
  });

  vi.doMock("../channels/registry.js", () => ({
    CHAT_CHANNEL_ORDER: [],
    CHANNEL_IDS: [],
    listChatChannels: () => [],
    listChatChannelAliases: () => [],
    getChatChannelMeta: () => ({ id: "demo-channel" }),
    normalizeChatChannelId: () => null,
    normalizeChannelId: () => null,
    normalizeAnyChannelId: () => null,
  }));

  vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: class {
      connect = vi.fn(async () => {});
      listTools = vi.fn(async () => ({ tools: [] }));
      close = vi.fn(async () => {});
    },
  }));

  vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
    StdioClientTransport: class {
      pid = null;
    },
  }));

  vi.doMock("../auto-reply/reply/get-reply-directives.js", () => ({
    resolveReplyDirectives: vi.fn(async () => ({ kind: "reply", reply: undefined })),
  }));

  vi.doMock("./web-search-providers.js", () => ({
    resolvePluginWebSearchProviders: () => [],
    resolveRuntimeWebSearchProviders: () => [],
  }));

  vi.doMock("../plugins/provider-runtime.runtime.js", () => ({
    augmentModelCatalogWithProviderPlugins: vi.fn(),
    buildProviderAuthDoctorHintWithPlugin: vi.fn(() => ""),
    buildProviderMissingAuthMessageWithPlugin: vi.fn(() => ""),
    formatProviderAuthProfileApiKeyWithPlugin: vi.fn(
      ({ context }: { context?: { access?: string } }) => context?.access ?? "",
    ),
    refreshProviderOAuthCredentialWithPlugin: vi.fn(async () => null),
  }));
};

type SessionResetModule = typeof import("../gateway/session-reset-service.js");

type SessionResetDeps = {
  loadConfig: ReturnType<typeof vi.fn>;
  performGatewaySessionReset: ReturnType<typeof vi.fn>;
  resolveGatewaySessionStoreTarget: ReturnType<typeof vi.fn>;
};

function resolveMockGatewayTarget(params: { key: string; cfg: OpenClawConfig }) {
  const trimmedKey = params.key.trim();
  const lowered = trimmedKey.toLowerCase();
  const sessionMainKey = (params.cfg.session?.mainKey ?? "main").trim().toLowerCase() || "main";
  const agentList = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  const defaultAgentId =
    (agentList.find((agent) => agent?.default)?.id ?? agentList[0]?.id ?? "main")
      ?.trim()
      .toLowerCase() || "main";

  if (lowered === "global" || lowered === "unknown") {
    return {
      agentId: defaultAgentId,
      storePath: "/tmp/session-store.json",
      canonicalKey: lowered,
      storeKeys: [lowered],
    };
  }

  let canonicalKey = lowered;
  let agentId = defaultAgentId;
  if (lowered.startsWith("agent:")) {
    const parts = lowered.split(":");
    agentId = parts[1] || defaultAgentId;
    const rest = parts.slice(2).join(":");
    if (rest === "main" || rest === sessionMainKey) {
      canonicalKey = `agent:${agentId}:${sessionMainKey}`;
    } else {
      canonicalKey = `agent:${agentId}:${rest}`;
    }
  } else if (lowered === "main" || lowered === sessionMainKey) {
    canonicalKey =
      params.cfg.session?.scope === "global"
        ? "global"
        : `agent:${defaultAgentId}:${sessionMainKey}`;
  } else {
    canonicalKey = `agent:${defaultAgentId}:${lowered}`;
  }

  const storeKeys = Array.from(new Set([canonicalKey, trimmedKey]));
  return {
    agentId,
    storePath: "/tmp/session-store.json",
    canonicalKey,
    storeKeys,
  };
}

type RegistryImportOptions = {
  sessionResetImportError?: Error;
  registrationMode?: PluginRegistrationMode;
  gatewaySupportsReset?: boolean;
  runtimeAvailable?: boolean;
  canonicalizationError?: Error;
};

function createRecord(): PluginRecord {
  return {
    id: "demo-plugin",
    name: "Demo Plugin",
    source: "/tmp/demo-plugin.ts",
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    webSearchProviderIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

async function createApiHarness(options?: RegistryImportOptions) {
  vi.resetModules();
  mockPluginSideEffects();

  const deps: SessionResetDeps = {
    loadConfig: vi.fn(() => ({}) as OpenClawConfig),
    resolveGatewaySessionStoreTarget: vi.fn(({ key, cfg }) => {
      if (options?.canonicalizationError) {
        throw options.canonicalizationError;
      }
      return resolveMockGatewayTarget({ key, cfg });
    }),
    performGatewaySessionReset: vi.fn(async (payload) => ({
      ok: true,
      key: payload.key,
      entry: { sessionId: "session-default" },
    })),
  };

  const createSessionResetModuleMock = (): SessionResetModule => ({
    archiveSessionTranscriptsForSession: vi.fn(() => []),
    cleanupSessionBeforeMutation: vi.fn(async () => undefined),
    emitSessionUnboundLifecycleEvent: vi.fn(async () => {}),
    performGatewaySessionReset:
      deps.performGatewaySessionReset as SessionResetModule["performGatewaySessionReset"],
  });

  const loadSessionResetModule: () => Promise<SessionResetModule> =
    typeof options?.sessionResetImportError === "undefined"
      ? async () => createSessionResetModuleMock()
      : async () => {
          throw options.sessionResetImportError;
        };

  vi.doMock("../gateway/session-utils.js", () => ({
    resolveGatewaySessionStoreTarget: deps.resolveGatewaySessionStoreTarget,
  }));

  const { createPluginRegistry } = await import("./registry.js");
  const { createApi } = createPluginRegistry({
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    coreGatewayHandlers:
      options?.gatewaySupportsReset === false ? {} : { "sessions.reset": async () => {} },
    runtime: createTestRuntime({
      available: options?.runtimeAvailable !== false,
      loadConfig: deps.loadConfig,
    }),
    loadSessionResetModule,
  });

  const api = createApi(createRecord(), {
    config: {} as OpenClawConfig,
    registrationMode: options?.registrationMode,
  });

  return { api, deps };
}

function createTestRuntime(params: {
  available?: boolean;
  loadConfig: SessionResetDeps["loadConfig"];
}): PluginRuntime {
  const run = vi.fn(async () => ({ runId: "run" }));
  const deleteSession =
    params.available === false
      ? run
      : vi.fn(async () => {
          return;
        });
  return {
    version: "test",
    config: {
      loadConfig: params.loadConfig as PluginRuntime["config"]["loadConfig"],
      writeConfigFile: vi.fn(),
    },
    subagent: {
      run,
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession,
    },
  } as unknown as PluginRuntime;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createApiWithDefaultMocks(options?: RegistryImportOptions) {
  const harness = await createApiHarness({
    ...options,
  });
  harness.deps.loadConfig.mockReturnValue({
    agents: { list: [{ id: "main", default: true }] },
    session: { mainKey: "main", scope: "agent" },
  } as unknown as OpenClawConfig);
  return harness;
}

afterEach(() => {
  vi.doUnmock("../gateway/session-reset-service.js");
  vi.doUnmock("../gateway/session-utils.js");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("plugin resetSession", () => {
  it("exposes a stable plugin API type", () => {
    expectTypeOf<OpenClawPluginApi["resetSession"]>().toEqualTypeOf<
      ((key: string, reason?: "new" | "reset") => Promise<PluginResetSessionResult>) | undefined
    >();
  });

  it("exposes resetSession on the real API object returned by createApi", async () => {
    const { api } = await createApiWithDefaultMocks();
    expect(api).toHaveProperty("resetSession");
    expect(api.resetSession).toBeTypeOf("function");
  });

  it("omits resetSession in setup-only registration mode", async () => {
    const { api } = await createApiHarness({ registrationMode: "setup-only" });
    expect(api.resetSession).toBeUndefined();
  });

  it("omits resetSession in setup-runtime registration mode", async () => {
    const { api } = await createApiHarness({ registrationMode: "setup-runtime" });
    expect(api.resetSession).toBeUndefined();
  });

  it("returns a structured failure when the runtime lacks the gateway reset path", async () => {
    const { api, deps } = await createApiHarness({ gatewaySupportsReset: false });

    await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
      ok: false,
      key: "agent:main:demo",
      error: "resetSession is only available while the gateway is running.",
    });
    expect(deps.performGatewaySessionReset).not.toHaveBeenCalled();
  });

  it("returns a structured failure when subagent runtime is unavailable", async () => {
    const { api, deps } = await createApiHarness({ runtimeAvailable: false });

    await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
      ok: false,
      key: "agent:main:demo",
      error: "resetSession is only available while the gateway is running.",
    });
    expect(deps.performGatewaySessionReset).not.toHaveBeenCalled();
  });

  it("rejects invalid keys before loading the reset module", async () => {
    const { api, deps } = await createApiHarness();

    await expect(api.resetSession?.(123 as never)).resolves.toEqual({
      ok: false,
      key: "",
      error: "resetSession key must be a string",
    });
    await expect(api.resetSession?.("")).resolves.toEqual({
      ok: false,
      key: "",
      error: "resetSession key must be a non-empty string",
    });
    await expect(api.resetSession?.("   ")).resolves.toEqual({
      ok: false,
      key: "",
      error: "resetSession key must be a non-empty string",
    });
    expect(deps.performGatewaySessionReset).not.toHaveBeenCalled();
  });

  it("trims keys and returns the reset result", async () => {
    const { api, deps } = await createApiWithDefaultMocks();
    deps.performGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "agent:main:demo",
      entry: { sessionId: "session-123" },
    });

    const result = await api.resetSession?.("  agent:main:demo  ");

    expect(result).toEqual({
      ok: true,
      key: "agent:main:demo",
      sessionId: "session-123",
    });
    expect(deps.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:main:demo",
      reason: "new",
      commandSource: "plugin:demo-plugin",
    });
    expect(deps.resolveGatewaySessionStoreTarget).toHaveBeenCalledWith({
      cfg: deps.loadConfig.mock.results[0]?.value,
      key: "agent:main:demo",
    });
  });

  it("passes through an explicit reset reason", async () => {
    const { api, deps } = await createApiWithDefaultMocks();
    deps.performGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "agent:main:demo",
      entry: { sessionId: "session-456" },
    });

    await api.resetSession?.("agent:main:demo", "reset");

    expect(deps.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:main:demo",
      reason: "reset",
      commandSource: "plugin:demo-plugin",
    });
  });

  it("uses live config for canonicalization instead of the captured API config", async () => {
    const { api, deps } = await createApiHarness();
    const liveConfig = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { mainKey: "work" },
    } as OpenClawConfig;
    const pending = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();

    deps.loadConfig.mockReturnValue(liveConfig);
    deps.performGatewaySessionReset.mockReturnValue(pending.promise);

    const first = api.resetSession?.("agent:ops:MAIN");
    const second = await api.resetSession?.("agent:ops:work");

    expect(second).toEqual({
      ok: false,
      key: "agent:ops:work",
      error: "Session reset already in progress for agent:ops:work.",
    });

    pending.resolve({
      ok: true,
      key: "agent:ops:work",
      entry: { sessionId: "session-live-config" },
    });
    await expect(first).resolves.toEqual({
      ok: true,
      key: "agent:ops:work",
      sessionId: "session-live-config",
    });
    expect(deps.loadConfig).toHaveBeenCalledTimes(2);
    expect(deps.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(deps.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:ops:MAIN",
      reason: "new",
      commandSource: "plugin:demo-plugin",
    });
  });

  it('falls back to "new" for invalid runtime reason values', async () => {
    const { api, deps } = await createApiWithDefaultMocks();
    deps.performGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "agent:main:demo",
      entry: { sessionId: "session-fallback" },
    });

    await expect(api.resetSession?.("agent:main:demo", "invalid" as never)).resolves.toEqual({
      ok: true,
      key: "agent:main:demo",
      sessionId: "session-fallback",
    });

    expect(deps.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:main:demo",
      reason: "new",
      commandSource: "plugin:demo-plugin",
    });
  });

  describe("failure normalization", () => {
    it("normalizes gateway failure objects to string errors", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockResolvedValue({
        ok: false,
        error: { code: "UNAVAILABLE", message: "try again later" },
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "try again later",
      });
    });

    it("normalizes helper throws from Error and string values", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockRejectedValueOnce(new Error("boom error"));
      deps.performGatewaySessionReset.mockRejectedValueOnce("boom string");

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "boom error",
      });
      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "boom string",
      });
    });

    it("normalizes canonicalization failure before invoking the reset helper", async () => {
      const { api, deps } = await createApiHarness({
        canonicalizationError: new Error("bad session key"),
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "bad session key",
      });
      expect(deps.performGatewaySessionReset).not.toHaveBeenCalled();
    });

    it("normalizes session-reset import failures", async () => {
      const { api } = await createApiHarness({
        sessionResetImportError: new Error("import setup failed"),
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "import setup failed",
      });
    });

    it("resolves structured failure instead of rejecting for operational failures", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockResolvedValue({
        ok: false,
        error: { message: "gateway rejected" },
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "gateway rejected",
      });
    });
  });

  describe("in-flight guard behavior", () => {
    it("blocks same canonical key while a reset is already in flight", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      const pending = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();
      deps.performGatewaySessionReset.mockReturnValue(pending.promise);

      const first = api.resetSession?.("agent:main:demo");
      const second = await api.resetSession?.("agent:main:demo");

      expect(second).toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "Session reset already in progress for agent:main:demo.",
      });

      pending.resolve({
        ok: true,
        key: "agent:main:demo",
        entry: { sessionId: "session-1" },
      });
      await expect(first).resolves.toEqual({
        ok: true,
        key: "agent:main:demo",
        sessionId: "session-1",
      });
    });

    it("allows different canonical keys concurrently", async () => {
      const { api, deps } = await createApiHarness();
      const first = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();
      const second = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();

      deps.performGatewaySessionReset
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      const firstCall = api.resetSession?.("agent:main:a");
      const secondCall = api.resetSession?.("agent:main:b");

      second.resolve({
        ok: true,
        key: "agent:main:b",
        entry: { sessionId: "session-b" },
      });
      first.resolve({
        ok: true,
        key: "agent:main:a",
        entry: { sessionId: "session-a" },
      });

      await expect(firstCall).resolves.toEqual({
        ok: true,
        key: "agent:main:a",
        sessionId: "session-a",
      });
      await expect(secondCall).resolves.toEqual({
        ok: true,
        key: "agent:main:b",
        sessionId: "session-b",
      });
    });

    it("blocks alias keys that resolve to the same canonical key", async () => {
      const { api, deps } = await createApiHarness();
      const pending = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();

      deps.loadConfig.mockReturnValue({
        agents: { list: [{ id: "ops", default: true }] },
        session: { mainKey: "work" },
      } as OpenClawConfig);
      deps.performGatewaySessionReset.mockReturnValue(pending.promise);

      const first = api.resetSession?.("agent:ops:MAIN");
      const second = await api.resetSession?.("agent:ops:work");

      expect(second).toEqual({
        ok: false,
        key: "agent:ops:work",
        error: "Session reset already in progress for agent:ops:work.",
      });

      pending.resolve({
        ok: true,
        key: "agent:ops:work",
        entry: { sessionId: "session-work" },
      });
      await first;
    });

    it("releases the in-flight guard after success and after failure", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset
        .mockResolvedValueOnce({
          ok: true,
          key: "agent:main:demo",
          entry: { sessionId: "session-ok" },
        })
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce({
          ok: true,
          key: "agent:main:demo",
          entry: { sessionId: "session-after-failure" },
        });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: true,
        key: "agent:main:demo",
        sessionId: "session-ok",
      });
      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "temporary failure",
      });
      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: true,
        key: "agent:main:demo",
        sessionId: "session-after-failure",
      });
    });
  });
});

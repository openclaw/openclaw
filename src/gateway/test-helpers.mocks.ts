import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { AgentBinding } from "../config/types.agents.js";
import {
  getTestPluginRegistry,
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "./test-helpers.plugin-registry.js";
import {
  agentCommand,
  cronIsolatedRun,
  dispatchInboundMessageMock,
  embeddedRunMock,
  type GetReplyFromConfigFn,
  getReplyFromConfig,
  getGatewayTestHoistedState,
  mockGetReplyFromConfigOnce,
  piSdkMock,
  runBtwSideQuestion,
  sendWhatsAppMock,
  sessionStoreSaveDelayMs,
  setTestConfigRoot,
  testConfigRoot,
  testIsNixMode,
  testState,
  testTailnetIPv4,
  testTailscaleWhois,
  type RunBtwSideQuestionFn,
} from "./test-helpers.runtime-state.js";

export { getTestPluginRegistry, resetTestPluginRegistry, setTestPluginRegistry };
export {
  agentCommand,
  cronIsolatedRun,
  dispatchInboundMessageMock,
  embeddedRunMock,
  getReplyFromConfig,
  mockGetReplyFromConfigOnce,
  piSdkMock,
  runBtwSideQuestion,
  sendWhatsAppMock,
  sessionStoreSaveDelayMs,
  setTestConfigRoot,
  testIsNixMode,
  testState,
  testTailnetIPv4,
  testTailscaleWhois,
};

function buildBundledPluginModuleId(pluginId: string, artifactBasename: string): string {
  return ["..", "..", "extensions", pluginId, artifactBasename].join("/");
}

const gatewayTestHoisted = getGatewayTestHoistedState();

function createEmbeddedRunMockExports() {
  return {
    isEmbeddedPiRunActive: (sessionId: string) => embeddedRunMock.activeIds.has(sessionId),
    abortEmbeddedPiRun: (sessionId: string) => {
      embeddedRunMock.abortCalls.push(sessionId);
      return embeddedRunMock.activeIds.has(sessionId);
    },
    waitForEmbeddedPiRunEnd: async (sessionId: string) => {
      embeddedRunMock.waitCalls.push(sessionId);
      return embeddedRunMock.waitResults.get(sessionId) ?? true;
    },
  };
}

async function importEmbeddedRunMockModule<TModule extends object>(
  actualPath: string,
  opts?: { includeActiveCount?: boolean },
): Promise<TModule> {
  const actual = await vi.importActual<TModule>(actualPath);
  return {
    ...actual,
    ...createEmbeddedRunMockExports(),
    ...(opts?.includeActiveCount
      ? { getActiveEmbeddedRunCount: () => embeddedRunMock.activeIds.size }
      : {}),
  };
}

vi.mock("../agents/pi-model-discovery.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/pi-model-discovery.js")>(
    "../agents/pi-model-discovery.js",
  );

  const createActualRegistry = (...args: Parameters<typeof actual.discoverModels>) => {
    const modelsFile = path.join(args[1], "models.json");
    const Registry = actual.ModelRegistry as unknown as {
      create?: (
        authStorage: unknown,
        modelsFile: string,
      ) => {
        getAll: () => Array<{ provider?: string; id?: string }>;
        getAvailable: () => Array<{ provider?: string; id?: string }>;
        find: (provider: string, modelId: string) => unknown;
      };
      new (
        authStorage: unknown,
        modelsFile: string,
      ): {
        getAll: () => Array<{ provider?: string; id?: string }>;
        getAvailable: () => Array<{ provider?: string; id?: string }>;
        find: (provider: string, modelId: string) => unknown;
      };
    };
    if (typeof Registry.create === "function") {
      return Registry.create(args[0], modelsFile);
    }
    return new Registry(args[0], modelsFile);
  };

  class MockModelRegistry {
    private readonly actualRegistry?: ReturnType<typeof createActualRegistry>;

    constructor(authStorage: unknown, modelsFile: string) {
      if (!piSdkMock.enabled) {
        this.actualRegistry = createActualRegistry(authStorage as never, path.dirname(modelsFile));
      }
    }

    getAll() {
      if (!piSdkMock.enabled) {
        return this.actualRegistry?.getAll() ?? [];
      }
      piSdkMock.discoverCalls += 1;
      return piSdkMock.models as Array<{ provider?: string; id?: string }>;
    }

    getAvailable() {
      if (!piSdkMock.enabled) {
        return this.actualRegistry?.getAvailable() ?? [];
      }
      return piSdkMock.models as Array<{ provider?: string; id?: string }>;
    }

    find(provider: string, modelId: string) {
      if (!piSdkMock.enabled) {
        return this.actualRegistry?.find(provider, modelId);
      }
      return (piSdkMock.models as Array<{ provider?: string; id?: string }>).find(
        (model) => model.provider === provider && model.id === modelId,
      );
    }
  }

  return {
    ...actual,
    ModelRegistry: MockModelRegistry,
  };
});

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: (...args: unknown[]) =>
    (cronIsolatedRun as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => testTailnetIPv4.value,
  pickPrimaryTailnetIPv6: () => undefined,
}));

vi.mock("../infra/tailscale.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/tailscale.js")>("../infra/tailscale.js");
  return {
    ...actual,
    readTailscaleWhoisIdentity: async () => testTailscaleWhois.value,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    saveSessionStore: vi.fn(async (storePath: string, store: unknown) => {
      const delay = sessionStoreSaveDelayMs.value;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return actual.saveSessionStore(storePath, store as never);
    }),
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const resolveConfigPath = () => path.join(testConfigRoot.value, "openclaw.json");
  const hashConfigRaw = (raw: string | null) =>
    crypto
      .createHash("sha256")
      .update(raw ?? "")
      .digest("hex");

  const composeTestConfig = (baseConfig: Record<string, unknown>) => {
    const fileAgents =
      baseConfig.agents &&
      typeof baseConfig.agents === "object" &&
      !Array.isArray(baseConfig.agents)
        ? (baseConfig.agents as Record<string, unknown>)
        : {};
    const fileDefaults =
      fileAgents.defaults &&
      typeof fileAgents.defaults === "object" &&
      !Array.isArray(fileAgents.defaults)
        ? (fileAgents.defaults as Record<string, unknown>)
        : {};
    const defaults = {
      model: { primary: "anthropic/claude-opus-4-6" },
      workspace: path.join(os.tmpdir(), "openclaw-gateway-test"),
      ...fileDefaults,
      ...testState.agentConfig,
    };
    const agents = testState.agentsConfig
      ? { ...fileAgents, ...testState.agentsConfig, defaults }
      : { ...fileAgents, defaults };

    const fileBindings = Array.isArray(baseConfig.bindings)
      ? (baseConfig.bindings as AgentBinding[])
      : undefined;

    const fileChannels =
      baseConfig.channels &&
      typeof baseConfig.channels === "object" &&
      !Array.isArray(baseConfig.channels)
        ? ({ ...(baseConfig.channels as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const overrideChannels =
      testState.channelsConfig && typeof testState.channelsConfig === "object"
        ? { ...testState.channelsConfig }
        : {};
    const mergedChannels = { ...fileChannels, ...overrideChannels };
    if (testState.allowFrom !== undefined) {
      const existing =
        mergedChannels.whatsapp &&
        typeof mergedChannels.whatsapp === "object" &&
        !Array.isArray(mergedChannels.whatsapp)
          ? (mergedChannels.whatsapp as Record<string, unknown>)
          : {};
      mergedChannels.whatsapp = {
        ...existing,
        allowFrom: testState.allowFrom,
      };
    }
    const channels = Object.keys(mergedChannels).length > 0 ? mergedChannels : undefined;

    const fileSession =
      baseConfig.session &&
      typeof baseConfig.session === "object" &&
      !Array.isArray(baseConfig.session)
        ? (baseConfig.session as Record<string, unknown>)
        : {};
    const session: Record<string, unknown> = {
      ...fileSession,
      mainKey: fileSession.mainKey ?? "main",
    };
    if (typeof testState.sessionStorePath === "string") {
      session.store = testState.sessionStorePath;
    }
    if (testState.sessionConfig) {
      Object.assign(session, testState.sessionConfig);
    }

    const fileGateway =
      baseConfig.gateway &&
      typeof baseConfig.gateway === "object" &&
      !Array.isArray(baseConfig.gateway)
        ? ({ ...(baseConfig.gateway as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    if (testState.gatewayBind) {
      fileGateway.bind = testState.gatewayBind;
    }
    if (testState.gatewayAuth) {
      fileGateway.auth = testState.gatewayAuth;
    }
    if (testState.gatewayControlUi) {
      const fileControlUi =
        fileGateway.controlUi &&
        typeof fileGateway.controlUi === "object" &&
        !Array.isArray(fileGateway.controlUi)
          ? (fileGateway.controlUi as Record<string, unknown>)
          : {};
      fileGateway.controlUi = {
        ...fileControlUi,
        ...testState.gatewayControlUi,
      };
    }
    const gateway = Object.keys(fileGateway).length > 0 ? fileGateway : undefined;

    const fileCanvasHost =
      baseConfig.canvasHost &&
      typeof baseConfig.canvasHost === "object" &&
      !Array.isArray(baseConfig.canvasHost)
        ? ({ ...(baseConfig.canvasHost as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    if (typeof testState.canvasHostPort === "number") {
      fileCanvasHost.port = testState.canvasHostPort;
    }
    const canvasHost = Object.keys(fileCanvasHost).length > 0 ? fileCanvasHost : undefined;

    const hooks = testState.hooksConfig ?? baseConfig.hooks;

    const fileCron =
      baseConfig.cron && typeof baseConfig.cron === "object" && !Array.isArray(baseConfig.cron)
        ? ({ ...(baseConfig.cron as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    if (typeof testState.cronEnabled === "boolean") {
      fileCron.enabled = testState.cronEnabled;
    }
    if (typeof testState.cronStorePath === "string") {
      fileCron.store = testState.cronStorePath;
    }
    const cron = Object.keys(fileCron).length > 0 ? fileCron : undefined;

    return {
      ...baseConfig,
      agents,
      bindings: testState.bindingsConfig ?? fileBindings,
      channels,
      session,
      gateway,
      canvasHost,
      hooks,
      cron,
    } as OpenClawConfig;
  };

  const readConfigFileSnapshot = async () => {
    if (testState.legacyIssues.length > 0) {
      const raw = JSON.stringify(testState.legacyParsed ?? {});
      return {
        path: resolveConfigPath(),
        exists: true,
        raw,
        parsed: testState.legacyParsed ?? {},
        valid: false,
        config: {},
        hash: hashConfigRaw(raw),
        issues: testState.legacyIssues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
        legacyIssues: testState.legacyIssues,
      };
    }
    const configPath = resolveConfigPath();
    try {
      await fs.access(configPath);
    } catch {
      return {
        path: configPath,
        exists: false,
        raw: null,
        parsed: {},
        valid: true,
        config: composeTestConfig({}),
        hash: hashConfigRaw(null),
        issues: [],
        legacyIssues: [],
      };
    }
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        path: configPath,
        exists: true,
        raw,
        parsed,
        valid: true,
        config: composeTestConfig(parsed),
        hash: hashConfigRaw(raw),
        issues: [],
        legacyIssues: [],
      };
    } catch (err) {
      return {
        path: configPath,
        exists: true,
        raw: null,
        parsed: {},
        valid: false,
        config: {},
        hash: hashConfigRaw(null),
        issues: [{ path: "", message: `read failed: ${String(err)}` }],
        legacyIssues: [],
      };
    }
  };

  const writeConfigFile = vi.fn(async (cfg: Record<string, unknown>) => {
    const configPath = resolveConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const raw = JSON.stringify(cfg, null, 2).trimEnd().concat("\n");
    await fs.writeFile(configPath, raw, "utf-8");
    actual.resetConfigRuntimeState();
  });

  const readConfigFileSnapshotForWrite = async () => ({
    snapshot: await readConfigFileSnapshot(),
    writeOptions: {
      expectedConfigPath: resolveConfigPath(),
    },
  });

  const loadTestConfig = () => {
    const configPath = resolveConfigPath();
    let fileConfig: Record<string, unknown> = {};
    try {
      if (fsSync.existsSync(configPath)) {
        const raw = fsSync.readFileSync(configPath, "utf-8");
        fileConfig = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      fileConfig = {};
    }
    return applyPluginAutoEnable({
      config: composeTestConfig(fileConfig),
      env: process.env,
    }).config;
  };

  const loadRuntimeAwareTestConfig = () => {
    const runtimeSnapshot = actual.getRuntimeConfigSnapshot();
    if (runtimeSnapshot) {
      return runtimeSnapshot;
    }
    const config = loadTestConfig();
    actual.setRuntimeConfigSnapshot(config);
    return config;
  };

  return {
    ...actual,
    get CONFIG_PATH() {
      return resolveConfigPath();
    },
    get STATE_DIR() {
      return path.dirname(resolveConfigPath());
    },
    get isNixMode() {
      return testIsNixMode.value;
    },
    migrateLegacyConfig: (raw: unknown) => ({
      config: testState.migrationConfig ?? (raw as Record<string, unknown>),
      changes: testState.migrationChanges,
    }),
    applyConfigOverrides: (cfg: OpenClawConfig) =>
      composeTestConfig(cfg as Record<string, unknown>),
    loadConfig: loadRuntimeAwareTestConfig,
    getRuntimeConfig: loadRuntimeAwareTestConfig,
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) as unknown };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    validateConfigObject: (parsed: unknown) => ({
      ok: true,
      config: parsed as Record<string, unknown>,
      issues: [],
    }),
    readConfigFileSnapshot,
    readConfigFileSnapshotForWrite,
    writeConfigFile,
  };
});

vi.mock("../agents/pi-embedded.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/pi-embedded.js")>(
    "../agents/pi-embedded.js",
  );
});

vi.mock("/src/agents/pi-embedded.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/pi-embedded.js")>(
    "../agents/pi-embedded.js",
  );
});

vi.mock("../agents/pi-embedded-runner/runs.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/pi-embedded-runner/runs.js")>(
    "../agents/pi-embedded-runner/runs.js",
    { includeActiveCount: true },
  );
});

vi.mock("/src/agents/pi-embedded-runner/runs.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/pi-embedded-runner/runs.js")>(
    "../agents/pi-embedded-runner/runs.js",
    { includeActiveCount: true },
  );
});

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock(buildBundledPluginModuleId("whatsapp", "runtime-api.js"), () => ({
  sendMessageWhatsApp: (...args: unknown[]) =>
    (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
  sendPollWhatsApp: (...args: unknown[]) =>
    (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));
vi.mock("../channels/web/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/web/index.js")>(
    "../channels/web/index.js",
  );
  return {
    ...actual,
    sendMessageWhatsApp: (...args: unknown[]) =>
      (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
  };
});
vi.mock("../commands/agent.js", () => ({
  agentCommand,
  agentCommandFromIngress: agentCommand,
}));
vi.mock("../agents/btw.js", () => ({
  runBtwSideQuestion: (...args: Parameters<RunBtwSideQuestionFn>) =>
    gatewayTestHoisted.runBtwSideQuestion(...args),
}));
vi.mock("/src/agents/btw.js", () => ({
  runBtwSideQuestion: (...args: Parameters<RunBtwSideQuestionFn>) =>
    gatewayTestHoisted.runBtwSideQuestion(...args),
}));
vi.mock("../auto-reply/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
    "../auto-reply/dispatch.js",
  );
  return {
    ...actual,
    dispatchInboundMessage: (...args: Parameters<typeof actual.dispatchInboundMessage>) => {
      const impl = gatewayTestHoisted.dispatchInboundMessage.getMockImplementation();
      return impl
        ? gatewayTestHoisted.dispatchInboundMessage(...args)
        : actual.dispatchInboundMessage(...args);
    },
  };
});
vi.mock("/src/auto-reply/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
    "../auto-reply/dispatch.js",
  );
  return {
    ...actual,
    dispatchInboundMessage: (...args: Parameters<typeof actual.dispatchInboundMessage>) => {
      const impl = gatewayTestHoisted.dispatchInboundMessage.getMockImplementation();
      return impl
        ? gatewayTestHoisted.dispatchInboundMessage(...args)
        : actual.dispatchInboundMessage(...args);
    },
  };
});
vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
}));

vi.mock("/src/auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
}));
vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
}));
vi.mock("/src/auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
}));
vi.mock("../cli/deps.js", async () => {
  const actual = await vi.importActual<typeof import("../cli/deps.js")>("../cli/deps.js");
  const base = actual.createDefaultDeps();
  return {
    ...actual,
    createDefaultDeps: () => ({
      ...base,
      sendMessageWhatsApp: (...args: unknown[]) =>
        (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
    }),
  };
});

vi.mock("../plugins/loader.js", async () => {
  const actual =
    await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
  return {
    ...actual,
    loadOpenClawPlugins: () => getTestPluginRegistry(),
  };
});
vi.mock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
  sendWebChannelMessage: (...args: unknown[]) =>
    (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));
vi.mock("/src/plugins/runtime/runtime-web-channel-plugin.js", () => ({
  sendWebChannelMessage: (...args: unknown[]) =>
    (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));

process.env.OPENCLAW_SKIP_CHANNELS = "1";
process.env.OPENCLAW_SKIP_CRON = "1";
process.env.OPENCLAW_SKIP_CHANNELS = "1";
process.env.OPENCLAW_SKIP_CRON = "1";

import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Mock, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions, ReplyPayload } from "../auto-reply/types.js";
import type { ChannelPlugin, ChannelOutboundAdapter } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { AgentBinding } from "../config/types.agents.js";
import type { HooksConfig } from "../config/types.hooks.js";
import type { TailscaleWhoisIdentity } from "../infra/tailscale.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

function buildBundledPluginModuleId(pluginId: string, artifactBasename: string): string {
  return ["..", "..", "extensions", pluginId, artifactBasename].join("/");
}

type StubChannelOptions = {
  id: ChannelPlugin["id"];
  label: string;
  summary?: Record<string, unknown>;
};

type GetReplyFromConfigFn = (
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
type CronIsolatedRunFn = (...args: unknown[]) => Promise<{ status: string; summary: string }>;
type AgentCommandFn = (...args: unknown[]) => Promise<void>;
type SendWhatsAppFn = (...args: unknown[]) => Promise<{ messageId: string; toJid: string }>;

const createStubOutboundAdapter = (channelId: ChannelPlugin["id"]): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendText: async () => ({
    channel: channelId,
    messageId: `${channelId}-msg`,
  }),
  sendMedia: async () => ({
    channel: channelId,
    messageId: `${channelId}-msg`,
  }),
});

const createStubChannelPlugin = (params: StubChannelOptions): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label,
    selectionLabel: params.label,
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => ({}),
    isConfigured: async () => false,
  },
  status: {
    buildChannelSummary: async () => ({
      configured: false,
      ...(params.summary ? params.summary : {}),
    }),
  },
  outbound: createStubOutboundAdapter(params.id),
  messaging: {
    normalizeTarget: (raw) => raw,
  },
  gateway: {
    logoutAccount: async () => ({
      cleared: false,
      envToken: false,
      loggedOut: false,
    }),
  },
});

type StubSpeechProviderOptions = {
  id: SpeechProviderPlugin["id"];
  label: string;
  aliases?: string[];
  voices?: string[];
  resolveTalkOverrides?: SpeechProviderPlugin["resolveTalkOverrides"];
  synthesize?: SpeechProviderPlugin["synthesize"];
};

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function fetchStubSpeechAudio(
  url: string,
  init: RequestInit,
  providerId: string,
): Promise<Buffer> {
  const withTimeout = async <T>(label: string, run: Promise<T>): Promise<T> =>
    await Promise.race([
      run,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${providerId} stub ${label} timed out`)), 5_000),
      ),
    ]);
  const response = await withTimeout("fetch", globalThis.fetch(url, init));
  const arrayBuffer = await withTimeout("read", response.arrayBuffer());
  return Buffer.from(arrayBuffer);
}

const createStubSpeechProvider = (params: StubSpeechProviderOptions): SpeechProviderPlugin => ({
  id: params.id,
  label: params.label,
  aliases: params.aliases,
  voices: params.voices,
  resolveTalkOverrides: params.resolveTalkOverrides,
  isConfigured: () => true,
  synthesize:
    params.synthesize ??
    (async () => ({
      audioBuffer: Buffer.from(`${params.id}-audio`, "utf8"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: true,
    })),
  listVoices: async () =>
    (params.voices ?? []).map((voiceId) => ({
      id: voiceId,
      name: voiceId,
    })),
});

const createStubPluginRegistry = (): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [
    {
      pluginId: "whatsapp",
      source: "test",
      plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
    },
    {
      pluginId: "telegram",
      source: "test",
      plugin: createStubChannelPlugin({
        id: "telegram",
        label: "Telegram",
        summary: { tokenSource: "none", lastProbeAt: null },
      }),
    },
    {
      pluginId: "discord",
      source: "test",
      plugin: createStubChannelPlugin({ id: "discord", label: "Discord" }),
    },
    {
      pluginId: "slack",
      source: "test",
      plugin: createStubChannelPlugin({ id: "slack", label: "Slack" }),
    },
    {
      pluginId: "signal",
      source: "test",
      plugin: createStubChannelPlugin({
        id: "signal",
        label: "Signal",
        summary: { lastProbeAt: null },
      }),
    },
    {
      pluginId: "imessage",
      source: "test",
      plugin: createStubChannelPlugin({ id: "imessage", label: "iMessage" }),
    },
    {
      pluginId: "msteams",
      source: "test",
      plugin: createStubChannelPlugin({ id: "msteams", label: "Microsoft Teams" }),
    },
    {
      pluginId: "matrix",
      source: "test",
      plugin: createStubChannelPlugin({ id: "matrix", label: "Matrix" }),
    },
    {
      pluginId: "zalo",
      source: "test",
      plugin: createStubChannelPlugin({ id: "zalo", label: "Zalo" }),
    },
    {
      pluginId: "zalouser",
      source: "test",
      plugin: createStubChannelPlugin({ id: "zalouser", label: "Zalo Personal" }),
    },
    {
      pluginId: "bluebubbles",
      source: "test",
      plugin: createStubChannelPlugin({ id: "bluebubbles", label: "BlueBubbles" }),
    },
  ],
  channelSetups: [],
  providers: [],
  speechProviders: [
    {
      pluginId: "openai",
      source: "test",
      provider: createStubSpeechProvider({
        id: "openai",
        label: "OpenAI",
        voices: ["alloy", "nova"],
        resolveTalkOverrides: ({ params }) => ({
          ...(trimString(params.voiceId) == null ? {} : { voice: trimString(params.voiceId) }),
          ...(trimString(params.modelId) == null ? {} : { model: trimString(params.modelId) }),
          ...(asNumber(params.speed) == null ? {} : { speed: asNumber(params.speed) }),
        }),
        synthesize: async (req) => {
          const config = req.providerConfig as Record<string, unknown>;
          const overrides = (req.providerOverrides ?? {}) as Record<string, unknown>;
          const body = JSON.stringify({
            input: req.text,
            model: trimString(overrides.model) ?? trimString(config.modelId) ?? "gpt-4o-mini-tts",
            voice: trimString(overrides.voice) ?? trimString(config.voiceId) ?? "alloy",
            ...(asNumber(overrides.speed) == null ? {} : { speed: asNumber(overrides.speed) }),
          });
          const audioBuffer = await fetchStubSpeechAudio(
            "https://api.openai.com/v1/audio/speech",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            },
            "openai",
          );
          return {
            audioBuffer,
            outputFormat: "mp3",
            fileExtension: ".mp3",
            voiceCompatible: false,
          };
        },
      }),
    },
    {
      pluginId: "elevenlabs",
      source: "test",
      provider: createStubSpeechProvider({
        id: "elevenlabs",
        label: "ElevenLabs",
        voices: ["EXAVITQu4vr4xnSDxMaL", "voice-default"],
        resolveTalkOverrides: ({ params }) => ({
          ...(trimString(params.voiceId) == null ? {} : { voiceId: trimString(params.voiceId) }),
          ...(trimString(params.modelId) == null ? {} : { modelId: trimString(params.modelId) }),
          ...(trimString(params.outputFormat) == null
            ? {}
            : { outputFormat: trimString(params.outputFormat) }),
          ...(asNumber(params.latencyTier) == null
            ? {}
            : { latencyTier: asNumber(params.latencyTier) }),
        }),
        synthesize: async (req) => {
          const config = req.providerConfig as Record<string, unknown>;
          const overrides = (req.providerOverrides ?? {}) as Record<string, unknown>;
          const voiceId =
            trimString(overrides.voiceId) ?? trimString(config.voiceId) ?? "voice-default";
          const outputFormat = trimString(overrides.outputFormat) ?? "mp3";
          const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
          url.searchParams.set("output_format", outputFormat);
          const audioBuffer = await fetchStubSpeechAudio(
            url.href,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: req.text,
                ...(asNumber(overrides.latencyTier) == null
                  ? {}
                  : { latency_optimization_level: asNumber(overrides.latencyTier) }),
              }),
            },
            "elevenlabs",
          );
          return {
            audioBuffer,
            outputFormat,
            fileExtension: outputFormat.startsWith("pcm") ? ".pcm" : ".mp3",
            voiceCompatible: false,
          };
        },
      }),
    },
  ],
  realtimeTranscriptionProviders: [],
  realtimeVoiceProviders: [],
  mediaUnderstandingProviders: [],
  imageGenerationProviders: [],
  videoGenerationProviders: [],
  webFetchProviders: [],
  webSearchProviders: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  conversationBindingResolvedHandlers: [],
  diagnostics: [],
});

const GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY = Symbol.for(
  "openclaw.gatewayTestHelpers.pluginRegistryState",
);
const GATEWAY_TEST_CONFIG_ROOT_KEY = Symbol.for("openclaw.gatewayTestHelpers.configRoot");

const hoisted = vi.hoisted(() => {
  const key = Symbol.for("openclaw.gatewayTestHelpers.hoisted");
  const store = globalThis as Record<PropertyKey, unknown>;
  if (Object.prototype.hasOwnProperty.call(store, key)) {
    return store[key] as {
      testTailnetIPv4: { value: string | undefined };
      piSdkMock: {
        enabled: boolean;
        discoverCalls: number;
        models: Array<{
          id: string;
          name?: string;
          provider: string;
          contextWindow?: number;
          reasoning?: boolean;
        }>;
      };
      cronIsolatedRun: Mock<CronIsolatedRunFn>;
      agentCommand: Mock<AgentCommandFn>;
      testIsNixMode: { value: boolean };
      sessionStoreSaveDelayMs: { value: number };
      embeddedRunMock: {
        activeIds: Set<string>;
        abortCalls: string[];
        waitCalls: string[];
        waitResults: Map<string, boolean>;
      };
      testTailscaleWhois: { value: TailscaleWhoisIdentity | null };
      getReplyFromConfig: Mock<GetReplyFromConfigFn>;
      sendWhatsAppMock: Mock<SendWhatsAppFn>;
      testState: {
        agentConfig: Record<string, unknown> | undefined;
        agentsConfig: Record<string, unknown> | undefined;
        bindingsConfig: AgentBinding[] | undefined;
        channelsConfig: Record<string, unknown> | undefined;
        sessionStorePath: string | undefined;
        sessionConfig: Record<string, unknown> | undefined;
        allowFrom: string[] | undefined;
        cronStorePath: string | undefined;
        cronEnabled: boolean | undefined;
        gatewayBind: "auto" | "lan" | "tailnet" | "loopback" | undefined;
        gatewayAuth: Record<string, unknown> | undefined;
        gatewayControlUi: Record<string, unknown> | undefined;
        hooksConfig: HooksConfig | undefined;
        canvasHostPort: number | undefined;
        legacyIssues: Array<{ path: string; message: string }>;
        legacyParsed: Record<string, unknown>;
        migrationConfig: Record<string, unknown> | null;
        migrationChanges: string[];
      };
    };
  }
  const created = {
    testTailnetIPv4: { value: undefined as string | undefined },
    piSdkMock: {
      enabled: false,
      discoverCalls: 0,
      models: [] as Array<{
        id: string;
        name?: string;
        provider: string;
        contextWindow?: number;
        reasoning?: boolean;
      }>,
    },
    cronIsolatedRun: vi.fn(async () => ({ status: "ok", summary: "ok" })),
    agentCommand: vi.fn().mockResolvedValue(undefined),
    testIsNixMode: { value: false },
    sessionStoreSaveDelayMs: { value: 0 },
    embeddedRunMock: {
      activeIds: new Set<string>(),
      abortCalls: [] as string[],
      waitCalls: [] as string[],
      waitResults: new Map<string, boolean>(),
    },
    testTailscaleWhois: { value: null as TailscaleWhoisIdentity | null },
    getReplyFromConfig: vi.fn<GetReplyFromConfigFn>().mockResolvedValue(undefined),
    sendWhatsAppMock: vi.fn().mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
    testState: {
      agentConfig: undefined as Record<string, unknown> | undefined,
      agentsConfig: undefined as Record<string, unknown> | undefined,
      bindingsConfig: undefined as AgentBinding[] | undefined,
      channelsConfig: undefined as Record<string, unknown> | undefined,
      sessionStorePath: undefined as string | undefined,
      sessionConfig: undefined as Record<string, unknown> | undefined,
      allowFrom: undefined as string[] | undefined,
      cronStorePath: undefined as string | undefined,
      cronEnabled: false as boolean | undefined,
      gatewayBind: undefined as "auto" | "lan" | "tailnet" | "loopback" | undefined,
      gatewayAuth: undefined as Record<string, unknown> | undefined,
      gatewayControlUi: undefined as Record<string, unknown> | undefined,
      hooksConfig: undefined as HooksConfig | undefined,
      canvasHostPort: undefined as number | undefined,
      legacyIssues: [] as Array<{ path: string; message: string }>,
      legacyParsed: {} as Record<string, unknown>,
      migrationConfig: null as Record<string, unknown> | null,
      migrationChanges: [] as string[],
    },
  };
  store[key] = created;
  return created;
});

const pluginRegistryState = resolveGlobalSingleton(GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY, () => ({
  registry: createStubPluginRegistry(),
}));
setActivePluginRegistry(pluginRegistryState.registry);

export const setTestPluginRegistry = (registry: PluginRegistry) => {
  pluginRegistryState.registry = registry;
  setActivePluginRegistry(registry);
};

export const resetTestPluginRegistry = () => {
  pluginRegistryState.registry = createStubPluginRegistry();
  setActivePluginRegistry(pluginRegistryState.registry);
};

const testConfigRoot = resolveGlobalSingleton(GATEWAY_TEST_CONFIG_ROOT_KEY, () => ({
  value: path.join(os.tmpdir(), `openclaw-gateway-test-${process.pid}-${crypto.randomUUID()}`),
}));

export const setTestConfigRoot = (root: string) => {
  testConfigRoot.value = root;
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
};

export const testTailnetIPv4 = hoisted.testTailnetIPv4;
export const testTailscaleWhois = hoisted.testTailscaleWhois;
export const piSdkMock = hoisted.piSdkMock;
export const cronIsolatedRun: Mock<CronIsolatedRunFn> = hoisted.cronIsolatedRun;
export const agentCommand: Mock<AgentCommandFn> = hoisted.agentCommand;
export const getReplyFromConfig: Mock<GetReplyFromConfigFn> = hoisted.getReplyFromConfig;
export const mockGetReplyFromConfigOnce = (impl: GetReplyFromConfigFn) => {
  getReplyFromConfig.mockImplementationOnce(impl);
};
export const sendWhatsAppMock: Mock<SendWhatsAppFn> = hoisted.sendWhatsAppMock;

export const testState = hoisted.testState;

export const testIsNixMode = hoisted.testIsNixMode;
export const sessionStoreSaveDelayMs = hoisted.sessionStoreSaveDelayMs;
export const embeddedRunMock = hoisted.embeddedRunMock;

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

    const hooks = testState.hooksConfig ?? (baseConfig.hooks as HooksConfig | undefined);

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
    (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
  sendPollWhatsApp: (...args: unknown[]) =>
    (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));
vi.mock("../channels/web/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/web/index.js")>(
    "../channels/web/index.js",
  );
  return {
    ...actual,
    sendMessageWhatsApp: (...args: unknown[]) =>
      (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
  };
});
vi.mock("../commands/agent.js", () => ({
  agentCommand,
  agentCommandFromIngress: agentCommand,
}));
vi.mock("../auto-reply/dispatch.js", async () => {
  return await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
    "../auto-reply/dispatch.js",
  );
});
vi.mock("/src/auto-reply/dispatch.js", async () => {
  return await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
    "../auto-reply/dispatch.js",
  );
});
vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    hoisted.getReplyFromConfig(...args),
}));

vi.mock("/src/auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    hoisted.getReplyFromConfig(...args),
}));
vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    hoisted.getReplyFromConfig(...args),
}));
vi.mock("/src/auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    hoisted.getReplyFromConfig(...args),
}));
vi.mock("../cli/deps.js", async () => {
  const actual = await vi.importActual<typeof import("../cli/deps.js")>("../cli/deps.js");
  const base = actual.createDefaultDeps();
  return {
    ...actual,
    createDefaultDeps: () => ({
      ...base,
      sendMessageWhatsApp: (...args: unknown[]) =>
        (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
    }),
  };
});

vi.mock("../plugins/loader.js", async () => {
  const actual =
    await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
  return {
    ...actual,
    loadOpenClawPlugins: () => pluginRegistryState.registry,
  };
});
vi.mock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
  sendWebChannelMessage: (...args: unknown[]) =>
    (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));
vi.mock("/src/plugins/runtime/runtime-web-channel-plugin.js", () => ({
  sendWebChannelMessage: (...args: unknown[]) =>
    (hoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));

process.env.OPENCLAW_SKIP_CHANNELS = "1";
process.env.OPENCLAW_SKIP_CRON = "1";
process.env.OPENCLAW_SKIP_CHANNELS = "1";
process.env.OPENCLAW_SKIP_CRON = "1";

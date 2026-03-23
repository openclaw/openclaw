import { afterAll, afterEach, beforeAll, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    getOAuthApiKey: () => undefined,
    getOAuthProviders: () => [],
    loginOpenAICodex: vi.fn(),
  };
});

// Ensure Vitest environment is properly set
process.env.VITEST = "true";
// Config validation walks plugin manifests; keep an aggressive cache in tests to avoid
// repeated filesystem discovery across suites/workers.
process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS ??= "60000";
// Vitest vm forks can load transitive lockfile helpers many times per worker.
// Raise listener budget to avoid noisy MaxListeners warnings and warning-stack overhead.
const TEST_PROCESS_MAX_LISTENERS = 128;
if (process.getMaxListeners() > 0 && process.getMaxListeners() < TEST_PROCESS_MAX_LISTENERS) {
  process.setMaxListeners(TEST_PROCESS_MAX_LISTENERS);
}

import { resetContextWindowCacheForTest } from "../src/agents/context.js";
import { resetModelsJsonReadyCacheForTest } from "../src/agents/models-config.js";
import { resetSessionWriteLockStateForTest } from "../src/agents/session-write-lock.js";
import { createTopLevelChannelReplyToModeResolver } from "../src/channels/plugins/threading-helpers.js";
import type {
  ChannelId,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../src/config/config.js";
import type { OutboundSendDeps } from "../src/infra/outbound/deliver.js";
import { installProcessWarningFilter } from "../src/infra/warning-filter.js";
import type { PluginRegistry } from "../src/plugins/registry.js";
import { withIsolatedTestHome } from "./test-env.js";

// Set HOME/state isolation before importing any runtime OpenClaw modules.
const testEnv = withIsolatedTestHome();

afterAll(() => {
  testEnv.cleanup();
});

installProcessWarningFilter();

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  httpRouteRegistry: PluginRegistry | null;
  httpRouteRegistryPinned: boolean;
  key: string | null;
  version: number;
};

type TestChannelRegistration = {
  pluginId: string;
  plugin: unknown;
  source: string;
};

const globalRegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: null,
      httpRouteRegistry: null,
      httpRouteRegistryPinned: false,
      key: null,
      version: 0,
    };
  }
  return globalState[REGISTRY_STATE];
})();

const pickSendFn = (id: ChannelId, deps?: OutboundSendDeps) => {
  return deps?.[id] as ((...args: unknown[]) => Promise<unknown>) | undefined;
};

function resolveSlackStubReplyToMode(params: {
  cfg: OpenClawConfig;
  chatType?: string | null;
}): "off" | "first" | "all" {
  const entry = (
    params.cfg.channels as
      | Record<
          string,
          {
            replyToMode?: "off" | "first" | "all";
            replyToModeByChatType?: Partial<
              Record<"direct" | "group" | "channel", "off" | "first" | "all">
            >;
            dm?: { replyToMode?: "off" | "first" | "all" };
          }
        >
      | undefined
  )?.slack;
  const normalizedChatType = params.chatType?.trim().toLowerCase();
  if (
    normalizedChatType === "direct" ||
    normalizedChatType === "group" ||
    normalizedChatType === "channel"
  ) {
    const byChatType = entry?.replyToModeByChatType?.[normalizedChatType];
    if (byChatType) {
      return byChatType;
    }
    if (normalizedChatType === "direct" && entry?.dm?.replyToMode) {
      return entry.dm.replyToMode;
    }
  }
  return entry?.replyToMode ?? "off";
}

const createStubOutbound = (
  id: ChannelId,
  deliveryMode: ChannelOutboundAdapter["deliveryMode"] = "direct",
): ChannelOutboundAdapter => ({
  deliveryMode,
  sendText: async ({ deps, to, text }) => {
    const send = pickSendFn(id, deps);
    if (send) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = (await send(to, text, { verbose: false } as any)) as {
        messageId: string;
      };
      return { channel: id, ...result };
    }
    return { channel: id, messageId: "test" };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    const send = pickSendFn(id, deps);
    if (send) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = (await send(to, text, { verbose: false, mediaUrl } as any)) as {
        messageId: string;
      };
      return { channel: id, ...result };
    }
    return { channel: id, messageId: "test" };
  },
});

const createStubPlugin = (params: {
  id: ChannelId;
  label?: string;
  aliases?: string[];
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
  preferSessionLookupForAnnounceTarget?: boolean;
  resolveReplyToMode?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    chatType?: string | null;
  }) => "off" | "first" | "all";
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
    aliases: params.aliases,
    preferSessionLookupForAnnounceTarget: params.preferSessionLookupForAnnounceTarget,
  },
  capabilities: { chatTypes: ["direct", "group"] },
  threading: params.resolveReplyToMode
    ? {
        resolveReplyToMode: params.resolveReplyToMode,
      }
    : undefined,
  config: {
    listAccountIds: (cfg: OpenClawConfig) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      const entry = channels?.[params.id];
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const accounts = (entry as { accounts?: Record<string, unknown> }).accounts;
      const ids = accounts ? Object.keys(accounts).filter(Boolean) : [];
      return ids.length > 0 ? ids : ["default"];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      const entry = channels?.[params.id];
      if (!entry || typeof entry !== "object") {
        return {};
      }
      const accounts = (entry as { accounts?: Record<string, unknown> }).accounts;
      const match = accountId ? accounts?.[accountId] : undefined;
      return (match && typeof match === "object") || typeof match === "string" ? match : entry;
    },
    isConfigured: async (_account, cfg: OpenClawConfig) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      return Boolean(channels?.[params.id]);
    },
  },
  outbound: createStubOutbound(params.id, params.deliveryMode),
});

const createTestRegistry = (channels: TestChannelRegistration[] = []): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: channels as unknown as PluginRegistry["channels"],
  channelSetups: channels.map((entry) => ({
    pluginId: entry.pluginId,
    plugin: entry.plugin as PluginRegistry["channelSetups"][number]["plugin"],
    source: entry.source,
    enabled: true,
  })),
  providers: [],
  speechProviders: [],
  mediaUnderstandingProviders: [],
  imageGenerationProviders: [],
  webSearchProviders: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  conversationBindingResolvedHandlers: [],
  diagnostics: [],
});

const createDefaultRegistry = () =>
  createTestRegistry([
    {
      pluginId: "discord",
      plugin: createStubPlugin({
        id: "discord",
        label: "Discord",
        resolveReplyToMode: createTopLevelChannelReplyToModeResolver("discord"),
      }),
      source: "test",
    },
    {
      pluginId: "slack",
      plugin: createStubPlugin({
        id: "slack",
        label: "Slack",
        resolveReplyToMode: ({ cfg, chatType }) => resolveSlackStubReplyToMode({ cfg, chatType }),
      }),
      source: "test",
    },
    {
      pluginId: "telegram",
      plugin: {
        ...createStubPlugin({
          id: "telegram",
          label: "Telegram",
          resolveReplyToMode: createTopLevelChannelReplyToModeResolver("telegram"),
        }),
        status: {
          buildChannelSummary: async () => ({
            configured: false,
            tokenSource: process.env.TELEGRAM_BOT_TOKEN ? "env" : "none",
          }),
        },
      },
      source: "test",
    },
    {
      pluginId: "whatsapp",
      plugin: createStubPlugin({
        id: "whatsapp",
        label: "WhatsApp",
        deliveryMode: "gateway",
        preferSessionLookupForAnnounceTarget: true,
      }),
      source: "test",
    },
    {
      pluginId: "signal",
      plugin: createStubPlugin({ id: "signal", label: "Signal" }),
      source: "test",
    },
    {
      pluginId: "imessage",
      plugin: createStubPlugin({ id: "imessage", label: "iMessage", aliases: ["imsg"] }),
      source: "test",
    },
  ]);

let materializedDefaultPluginRegistry: PluginRegistry | null = null;

function getDefaultPluginRegistry(): PluginRegistry {
  materializedDefaultPluginRegistry ??= createDefaultRegistry();
  return materializedDefaultPluginRegistry;
}

// Most unit suites never touch the plugin registry. Keep the default test registry
// behind a lazy proxy so those files avoid allocating channel fixtures up front.
const DEFAULT_PLUGIN_REGISTRY = new Proxy({} as PluginRegistry, {
  defineProperty(_target, property, attributes) {
    return Reflect.defineProperty(getDefaultPluginRegistry() as object, property, attributes);
  },
  deleteProperty(_target, property) {
    return Reflect.deleteProperty(getDefaultPluginRegistry() as object, property);
  },
  get(_target, property, receiver) {
    return Reflect.get(getDefaultPluginRegistry() as object, property, receiver);
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(getDefaultPluginRegistry() as object, property);
  },
  has(_target, property) {
    return Reflect.has(getDefaultPluginRegistry() as object, property);
  },
  ownKeys() {
    return Reflect.ownKeys(getDefaultPluginRegistry() as object);
  },
  set(_target, property, value, receiver) {
    return Reflect.set(getDefaultPluginRegistry() as object, property, value, receiver);
  },
});

function installDefaultPluginRegistry(): void {
  globalRegistryState.registry = DEFAULT_PLUGIN_REGISTRY;
  if (!globalRegistryState.httpRouteRegistryPinned) {
    globalRegistryState.httpRouteRegistry = DEFAULT_PLUGIN_REGISTRY;
  }
}

beforeAll(() => {
  installDefaultPluginRegistry();
});

afterEach(() => {
  resetContextWindowCacheForTest();
  resetModelsJsonReadyCacheForTest();
  resetSessionWriteLockStateForTest();
  if (globalRegistryState.registry !== DEFAULT_PLUGIN_REGISTRY) {
    installDefaultPluginRegistry();
    globalRegistryState.key = null;
    globalRegistryState.version += 1;
  }
});

afterAll(() => {
  resetSessionWriteLockStateForTest();
});

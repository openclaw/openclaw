import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  getSessionBindingService,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../plugin-sdk/line.js";
import { loadBundledPluginTestApiSync } from "../../../test-utils/bundled-plugin-public-surface.js";
import {
  listBundledChannelPlugins,
  requireBundledChannelPlugin,
  setBundledChannelRuntime,
} from "../bundled.js";
import { createChannelConversationBindingManager } from "../conversation-bindings.js";
import type { ChannelPlugin } from "../types.js";
import {
  channelPluginSurfaceKeys,
  type ChannelPluginSurface,
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId,
} from "./manifest.js";

type DiscordThreadBindingTesting = {
  resetThreadBindingsForTests: () => void;
};

let discordThreadBindingTestingCache: DiscordThreadBindingTesting | undefined;
let discordRuntimeApiPromise:
  | Promise<typeof import("../../../../extensions/discord/runtime-api.js")>
  | undefined;
let feishuApiPromise: Promise<typeof import("../../../../extensions/feishu/api.js")> | undefined;
let matrixApiPromise: Promise<typeof import("../../../../extensions/matrix/api.js")> | undefined;
let matrixRuntimeApiPromise:
  | Promise<typeof import("../../../../extensions/matrix/runtime-api.js")>
  | undefined;

function getDiscordThreadBindingTesting(): DiscordThreadBindingTesting {
  if (!discordThreadBindingTestingCache) {
    ({ discordThreadBindingTesting: discordThreadBindingTestingCache } =
      loadBundledPluginTestApiSync<{
        discordThreadBindingTesting: DiscordThreadBindingTesting;
      }>("discord"));
  }
  return discordThreadBindingTestingCache;
}

async function getDiscordRuntimeApi() {
  discordRuntimeApiPromise ??= import("../../../../extensions/discord/runtime-api.js");
  return await discordRuntimeApiPromise;
}

async function getFeishuApi() {
  feishuApiPromise ??= import("../../../../extensions/feishu/api.js");
  return await feishuApiPromise;
}

async function getMatrixApi() {
  matrixApiPromise ??= import("../../../../extensions/matrix/api.js");
  return await matrixApiPromise;
}

async function getMatrixRuntimeApi() {
  matrixRuntimeApiPromise ??= import("../../../../extensions/matrix/runtime-api.js");
  return await matrixRuntimeApiPromise;
}

function buildBundledPluginModuleId(pluginId: string, artifactBasename: string): string {
  return ["..", "..", "..", "..", "extensions", pluginId, artifactBasename].join("/");
}

type PluginContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
};

type ActionsContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "actions">;
  unsupportedAction?: string;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    expectedActions: string[];
    expectedCapabilities?: string[];
    beforeTest?: () => void;
  }>;
};

type SetupContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "config" | "setup">;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    input: Record<string, unknown>;
    expectedAccountId?: string;
    expectedValidation?: string | null;
    beforeTest?: () => void;
    assertPatchedConfig?: (cfg: OpenClawConfig) => void;
    assertResolvedAccount?: (account: unknown, cfg: OpenClawConfig) => void;
  }>;
};

type StatusContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "config" | "status">;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    runtime?: Record<string, unknown>;
    probe?: unknown;
    beforeTest?: () => void;
    assertSnapshot?: (snapshot: Record<string, unknown>) => void;
    assertSummary?: (summary: Record<string, unknown>) => void;
  }>;
};

type SurfaceContractEntry = {
  id: string;
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  surfaces: readonly ChannelPluginSurface[];
};

type ThreadingContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "threading">;
};

type DirectoryContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
};

type SessionBindingContractEntry = {
  id: string;
  expectedCapabilities: SessionBindingCapabilities;
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
};

function expectResolvedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }),
  )?.toMatchObject({
    targetSessionKey: params.targetSessionKey,
  });
}

async function unbindAndExpectClearedSessionBinding(binding: SessionBindingRecord) {
  const service = getSessionBindingService();
  const removed = await service.unbind({
    bindingId: binding.bindingId,
    reason: "contract-test",
  });
  expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
  expect(service.resolveByConversation(binding.conversation)).toBeNull();
}

function expectClearedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
    }),
  ).toBeNull();
}

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (to: string, _message: string, opts?: { threadId?: string }) => ({
    messageId: opts?.threadId ? "$matrix-thread" : "$matrix-root",
    roomId: to.replace(/^room:/, ""),
  })),
);

setBundledChannelRuntime("line", {
  channel: {
    line: {
      listLineAccountIds,
      resolveDefaultLineAccountId,
      resolveLineAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
        resolveLineAccount({ cfg, accountId }),
    },
  },
} as never);

vi.mock(buildBundledPluginModuleId("matrix", "runtime-api.js"), async () => {
  const matrixRuntimeApiModuleId = buildBundledPluginModuleId("matrix", "runtime-api.js");
  const actual = await vi.importActual(matrixRuntimeApiModuleId);
  return {
    ...actual,
    sendMessageMatrix: sendMessageMatrixMock,
  };
});

const matrixSessionBindingStateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "openclaw-matrix-session-binding-contract-"),
);
const matrixSessionBindingAuth = {
  accountId: "ops",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "token",
} as const;

function resetMatrixSessionBindingStateDir() {
  fs.rmSync(matrixSessionBindingStateDir, { recursive: true, force: true });
  fs.mkdirSync(matrixSessionBindingStateDir, { recursive: true });
}

async function createContractMatrixThreadBindingManager() {
  resetMatrixSessionBindingStateDir();
  const { setMatrixRuntime } = await getMatrixRuntimeApi();
  const { createMatrixThreadBindingManager } = await getMatrixApi();
  setMatrixRuntime({
    state: {
      resolveStateDir: () => matrixSessionBindingStateDir,
    },
  } as never);
  return await createMatrixThreadBindingManager({
    accountId: matrixSessionBindingAuth.accountId,
    auth: matrixSessionBindingAuth,
    client: {} as never,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
    enableSweeper: false,
  });
}

export const pluginContractRegistry: PluginContractEntry[] = listBundledChannelPlugins().map(
  (plugin) => ({
    id: plugin.id,
    plugin,
  }),
);

export const actionContractRegistry: ActionsContractEntry[] = [
  {
    id: "slack",
    plugin: requireBundledChannelPlugin("slack"),
    unsupportedAction: "poll",
    cases: [
      {
        name: "configured account exposes default Slack actions",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
            },
          },
        } as OpenClawConfig,
        expectedActions: [
          "send",
          "react",
          "reactions",
          "read",
          "edit",
          "delete",
          "download-file",
          "upload-file",
          "pin",
          "unpin",
          "list-pins",
          "member-info",
          "emoji-list",
        ],
        expectedCapabilities: ["blocks"],
      },
      {
        name: "interactive replies add the shared interactive capability",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              capabilities: {
                interactiveReplies: true,
              },
            },
          },
        } as OpenClawConfig,
        expectedActions: [
          "send",
          "react",
          "reactions",
          "read",
          "edit",
          "delete",
          "download-file",
          "upload-file",
          "pin",
          "unpin",
          "list-pins",
          "member-info",
          "emoji-list",
        ],
        expectedCapabilities: ["blocks", "interactive"],
      },
      {
        name: "missing tokens disables the actions surface",
        cfg: {
          channels: {
            slack: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        expectedActions: [],
        expectedCapabilities: [],
      },
    ],
  },
  {
    id: "mattermost",
    plugin: requireBundledChannelPlugin("mattermost"),
    unsupportedAction: "poll",
    cases: [
      {
        name: "configured account exposes send and react",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "react"],
        expectedCapabilities: ["buttons"],
      },
      {
        name: "reactions can be disabled while send stays available",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
              actions: { reactions: false },
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send"],
        expectedCapabilities: ["buttons"],
      },
      {
        name: "missing bot credentials disables the actions surface",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        expectedActions: [],
        expectedCapabilities: [],
      },
    ],
  },
  {
    id: "telegram",
    plugin: requireBundledChannelPlugin("telegram"),
    cases: [
      {
        name: "exposes configured Telegram actions and capabilities",
        cfg: {
          channels: {
            telegram: {
              botToken: "123:telegram-test-token",
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "poll", "react", "delete", "edit", "topic-create", "topic-edit"],
        expectedCapabilities: ["interactive", "buttons"],
      },
    ],
  },
  {
    id: "discord",
    plugin: requireBundledChannelPlugin("discord"),
    cases: [
      {
        name: "describes configured Discord actions and capabilities",
        cfg: {
          channels: {
            discord: {
              token: "Bot token-main",
              actions: {
                polls: true,
                reactions: true,
                permissions: false,
                messages: false,
                pins: false,
                threads: false,
                search: false,
                stickers: false,
                memberInfo: false,
                roleInfo: false,
                emojiUploads: false,
                stickerUploads: false,
                channelInfo: false,
                channels: false,
                voiceStatus: false,
                events: false,
                roles: false,
                moderation: false,
                presence: false,
              },
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "poll", "react", "reactions", "emoji-list"],
        expectedCapabilities: ["interactive", "components"],
      },
    ],
  },
];

export const setupContractRegistry: SetupContractEntry[] = [
  {
    id: "slack",
    plugin: requireBundledChannelPlugin("slack"),
    cases: [
      {
        name: "default account stores tokens and enables the channel",
        cfg: {} as OpenClawConfig,
        input: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack?.enabled).toBe(true);
          expect(cfg.channels?.slack?.botToken).toBe("xoxb-test");
          expect(cfg.channels?.slack?.appToken).toBe("xapp-test");
        },
      },
      {
        name: "non-default env setup is rejected",
        cfg: {} as OpenClawConfig,
        accountId: "ops",
        input: {
          useEnv: true,
        },
        expectedAccountId: "ops",
        expectedValidation: "Slack env tokens can only be used for the default account.",
      },
    ],
  },
  {
    id: "mattermost",
    plugin: requireBundledChannelPlugin("mattermost"),
    cases: [
      {
        name: "default account stores token and normalized base URL",
        cfg: {} as OpenClawConfig,
        input: {
          botToken: "test-token",
          httpUrl: "https://chat.example.com/",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.mattermost?.enabled).toBe(true);
          expect(cfg.channels?.mattermost?.botToken).toBe("test-token");
          expect(cfg.channels?.mattermost?.baseUrl).toBe("https://chat.example.com");
        },
      },
      {
        name: "missing credentials are rejected",
        cfg: {} as OpenClawConfig,
        input: {
          httpUrl: "",
        },
        expectedAccountId: "default",
        expectedValidation: "Mattermost requires --bot-token and --http-url (or --use-env).",
      },
    ],
  },
  {
    id: "line",
    plugin: requireBundledChannelPlugin("line"),
    cases: [
      {
        name: "default account stores token and secret",
        cfg: {} as OpenClawConfig,
        input: {
          channelAccessToken: "line-token",
          channelSecret: "line-secret",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.line?.enabled).toBe(true);
          expect(cfg.channels?.line?.channelAccessToken).toBe("line-token");
          expect(cfg.channels?.line?.channelSecret).toBe("line-secret");
        },
      },
      {
        name: "non-default env setup is rejected",
        cfg: {} as OpenClawConfig,
        accountId: "ops",
        input: {
          useEnv: true,
        },
        expectedAccountId: "ops",
        expectedValidation: "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.",
      },
    ],
  },
];

export const statusContractRegistry: StatusContractEntry[] = [
  {
    id: "slack",
    plugin: requireBundledChannelPlugin("slack"),
    cases: [
      {
        name: "configured account produces a configured status snapshot",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
            },
          },
        } as OpenClawConfig,
        runtime: {
          accountId: "default",
          connected: true,
          running: true,
        },
        probe: { ok: true },
        assertSnapshot: (snapshot) => {
          expect(snapshot.accountId).toBe("default");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.configured).toBe(true);
        },
      },
    ],
  },
  {
    id: "mattermost",
    plugin: requireBundledChannelPlugin("mattermost"),
    cases: [
      {
        name: "configured account preserves connectivity details in the snapshot",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
            },
          },
        } as OpenClawConfig,
        runtime: {
          accountId: "default",
          connected: true,
          lastConnectedAt: 1234,
        },
        probe: { ok: true },
        assertSnapshot: (snapshot) => {
          expect(snapshot.accountId).toBe("default");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.configured).toBe(true);
          expect(snapshot.connected).toBe(true);
          expect(snapshot.baseUrl).toBe("https://chat.example.com");
        },
      },
    ],
  },
  {
    id: "line",
    plugin: requireBundledChannelPlugin("line"),
    cases: [
      {
        name: "configured account produces a webhook status snapshot",
        cfg: {
          channels: {
            line: {
              enabled: true,
              channelAccessToken: "line-token",
              channelSecret: "line-secret",
            },
          },
        } as OpenClawConfig,
        runtime: {
          accountId: "default",
          running: true,
        },
        probe: { ok: true },
        assertSnapshot: (snapshot) => {
          expect(snapshot.accountId).toBe("default");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.configured).toBe(true);
          expect(snapshot.mode).toBe("webhook");
        },
      },
    ],
  },
];

export const surfaceContractRegistry: SurfaceContractEntry[] = listBundledChannelPlugins().map(
  (plugin) => ({
    id: plugin.id,
    plugin,
    surfaces: channelPluginSurfaceKeys.filter((surface) => Boolean(plugin[surface])),
  }),
);

export const threadingContractRegistry: ThreadingContractEntry[] = surfaceContractRegistry
  .filter((entry) => entry.surfaces.includes("threading"))
  .map((entry) => ({
    id: entry.id,
    plugin: entry.plugin,
  }));

const directoryPresenceOnlyIds = new Set(["whatsapp", "zalouser"]);

export const directoryContractRegistry: DirectoryContractEntry[] = surfaceContractRegistry
  .filter((entry) => entry.surfaces.includes("directory"))
  .map((entry) => ({
    id: entry.id,
    plugin: entry.plugin,
    coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
  }));

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

const sessionBindingContractEntries: Record<
  SessionBindingContractChannelId,
  Omit<SessionBindingContractEntry, "id">
> = {
  bluebubbles: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "bluebubbles",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:codex:acp:binding:bluebubbles:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "bluebubbles",
          accountId: "default",
          conversationId: "+15555550123",
        },
        placement: "current",
        metadata: {
          agentId: "codex",
          label: "codex-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "bluebubbles",
        accountId: "default",
        conversationId: "+15555550123",
        targetSessionKey: "agent:codex:acp:binding:bluebubbles:default:abc123",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "bluebubbles",
        accountId: "default",
        conversationId: "+15555550123",
      });
    },
  },
  discord: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: async () => {
      const { createThreadBindingManager } = await getDiscordRuntimeApi();
      createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      return getSessionBindingService().getCapabilities({
        channel: "discord",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      const { createThreadBindingManager } = await getDiscordRuntimeApi();
      createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:discord:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:123456789012345678",
        },
        placement: "current",
        metadata: {
          label: "codex-discord",
        },
      });
      expectResolvedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
        targetSessionKey: "agent:discord:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const { createThreadBindingManager } = await getDiscordRuntimeApi();
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      manager.stop();
      getDiscordThreadBindingTesting().resetThreadBindingsForTests();
      expectClearedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
      });
    },
  },
  feishu: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: async () => {
      const { createFeishuThreadBindingManager } = await getFeishuApi();
      createFeishuThreadBindingManager({ cfg: baseSessionBindingCfg, accountId: "default" });
      return getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      const { createFeishuThreadBindingManager } = await getFeishuApi();
      createFeishuThreadBindingManager({ cfg: baseSessionBindingCfg, accountId: "default" });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "default",
          conversationId: "oc_group_chat:topic:om_topic_root",
          parentConversationId: "oc_group_chat",
        },
        placement: "current",
        metadata: {
          agentId: "codex",
          label: "codex-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const { createFeishuThreadBindingManager } = await getFeishuApi();
      const manager = createFeishuThreadBindingManager({
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      manager.stop();
      expectClearedSessionBinding({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
      });
    },
  },
  imessage: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "imessage",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:codex:acp:binding:imessage:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "imessage",
          accountId: "default",
          conversationId: "+15555550123",
        },
        placement: "current",
        metadata: {
          agentId: "codex",
          label: "codex-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "imessage",
        accountId: "default",
        conversationId: "+15555550123",
        targetSessionKey: "agent:codex:acp:binding:imessage:default:abc123",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "imessage",
        accountId: "default",
        conversationId: "+15555550123",
      });
    },
  },
  matrix: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: async () => {
      await createContractMatrixThreadBindingManager();
      return getSessionBindingService().getCapabilities({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
      });
    },
    bindAndResolve: async () => {
      await createContractMatrixThreadBindingManager();
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:matrix:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: matrixSessionBindingAuth.accountId,
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        placement: "current",
        metadata: {
          label: "codex-matrix",
        },
      });
      expectResolvedSessionBinding({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
        conversationId: "$thread",
        targetSessionKey: "agent:matrix:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const { resetMatrixThreadBindingsForTests } = await getMatrixApi();
      resetMatrixThreadBindingsForTests();
      resetMatrixSessionBindingStateDir();
      expectClearedSessionBinding({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
        conversationId: "$thread",
      });
    },
  },
  telegram: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "telegram",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100200300:topic:77",
        },
        placement: "current",
        metadata: {
          boundBy: "user-1",
        },
      });
      expectResolvedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
        targetSessionKey: "agent:main:subagent:child-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
      });
    },
  },
};

export const sessionBindingContractRegistry: SessionBindingContractEntry[] =
  sessionBindingContractChannelIds.map((id) => ({
    id,
    ...sessionBindingContractEntries[id],
  }));
